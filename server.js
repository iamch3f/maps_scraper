import express from 'express';
import { randomUUID } from 'crypto';
import { scrapeGoogleMaps, cleanup } from './scraper.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;
const DEFAULT_WORKERS = parseInt(process.env.WORKERS || '3');
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '5');

// In-memory job storage
const jobs = new Map();
let activeJobs = 0;

// API key auth middleware
const authMiddleware = (req, res, next) => {
    if (!API_KEY) return next();

    const providedKey = req.headers['x-api-key'];
    if (providedKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '2.0.0-optimized',
        activeJobs,
        maxConcurrent: MAX_CONCURRENT_JOBS
    });
});

/**
 * POST /scrape
 * Synchronous scrape with optimizations
 */
app.post('/scrape', authMiddleware, async (req, res) => {
    const { query, maxResults = 20, workers = DEFAULT_WORKERS } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'query is required' });
    }

    if (activeJobs >= MAX_CONCURRENT_JOBS) {
        return res.status(429).json({
            error: 'Too many concurrent requests',
            activeJobs,
            maxConcurrent: MAX_CONCURRENT_JOBS
        });
    }

    activeJobs++;
    console.log(`[API] Scrape: "${query}" (max: ${maxResults}, workers: ${workers})`);

    try {
        const startTime = Date.now();

        const results = await scrapeGoogleMaps(query, {
            maxResults: Math.min(maxResults, 100),  // Cap at 100
            workers: Math.min(workers, 5)  // Cap at 5 workers
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const speed = (results.length / parseFloat(duration)).toFixed(2);

        console.log(`[API] Done: ${results.length} results in ${duration}s (${speed}/s)`);

        res.json({
            success: true,
            query,
            count: results.length,
            duration: `${duration}s`,
            speed: `${speed} results/sec`,
            results
        });

    } catch (error) {
        console.error('[API] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        activeJobs--;
    }
});

/**
 * POST /scrape/bulk
 * Scrape multiple queries (optimized)
 */
app.post('/scrape/bulk', authMiddleware, async (req, res) => {
    const { queries, maxResults = 10, workers = DEFAULT_WORKERS } = req.body;

    if (!queries || !Array.isArray(queries) || queries.length === 0) {
        return res.status(400).json({ error: 'queries array is required' });
    }

    if (queries.length > 20) {
        return res.status(400).json({ error: 'Maximum 20 queries per request' });
    }

    console.log(`[API] Bulk: ${queries.length} queries`);

    const startTime = Date.now();
    const allResults = {};
    const errors = {};

    // Run queries in parallel (up to 3 at a time)
    const batchSize = 3;
    for (let i = 0; i < queries.length; i += batchSize) {
        const batch = queries.slice(i, i + batchSize);

        const batchResults = await Promise.allSettled(
            batch.map(query =>
                scrapeGoogleMaps(query, { maxResults, workers })
                    .then(results => ({ query, results }))
            )
        );

        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                allResults[result.value.query] = result.value.results;
            } else {
                const query = batch[batchResults.indexOf(result)];
                errors[query] = result.reason?.message || 'Unknown error';
            }
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    res.json({
        success: true,
        totalQueries: queries.length,
        successfulQueries: Object.keys(allResults).length,
        duration: `${duration}s`,
        results: allResults,
        errors: Object.keys(errors).length > 0 ? errors : undefined
    });
});

/**
 * POST /scrape/async
 * Async job for long-running scrapes
 */
app.post('/scrape/async', authMiddleware, async (req, res) => {
    const { query, maxResults = 20, workers = DEFAULT_WORKERS } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'query is required' });
    }

    const jobId = randomUUID();

    jobs.set(jobId, {
        status: 'pending',
        query,
        createdAt: new Date().toISOString(),
        results: null,
        error: null
    });

    console.log(`[API] Async job: ${jobId}`);

    // Background execution
    scrapeGoogleMaps(query, { maxResults, workers })
        .then(results => {
            jobs.set(jobId, {
                ...jobs.get(jobId),
                status: 'completed',
                results,
                completedAt: new Date().toISOString()
            });
            console.log(`[API] Job ${jobId}: ${results.length} results`);
        })
        .catch(error => {
            jobs.set(jobId, {
                ...jobs.get(jobId),
                status: 'failed',
                error: error.message,
                completedAt: new Date().toISOString()
            });
            console.error(`[API] Job ${jobId} failed:`, error.message);
        });

    res.json({ jobId, status: 'pending' });
});

// Status endpoint
app.get('/scrape/status/:jobId', authMiddleware, (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.json({ jobId: req.params.jobId, ...job });
});

// List jobs
app.get('/jobs', authMiddleware, (req, res) => {
    const jobList = Array.from(jobs.entries()).map(([id, job]) => ({
        jobId: id,
        status: job.status,
        query: job.query,
        createdAt: job.createdAt,
        resultCount: job.results?.length || 0
    }));

    res.json({ jobs: jobList });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('[API] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
const gracefulShutdown = async () => {
    console.log('\n[API] Shutting down gracefully...');
    await cleanup();
    process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║     Google Maps Scraper API v2.0 (OPTIMIZED)               ║
║     Port: ${PORT}  |  Workers: ${DEFAULT_WORKERS}  |  Max Jobs: ${MAX_CONCURRENT_JOBS}              ║
╠════════════════════════════════════════════════════════════╣
║  Optimizations:                                            ║
║  ✓ Request Interception (blocks images/fonts)              ║
║  ✓ Parallel Context Workers (3x default)                   ║
║  ✓ Browser Pool (connection reuse)                         ║
║  ✓ Smart Waits (no fixed timeouts)                         ║
║  ✓ Batch URL Collection                                    ║
╠════════════════════════════════════════════════════════════╣
║  Endpoints:                                                ║
║  • GET  /health              - Health check                ║
║  • POST /scrape              - Sync scrape                 ║
║  • POST /scrape/bulk         - Multi-query                 ║
║  • POST /scrape/async        - Background job              ║
║  • GET  /scrape/status/:id   - Job status                  ║
╚════════════════════════════════════════════════════════════╝
  `);
});
