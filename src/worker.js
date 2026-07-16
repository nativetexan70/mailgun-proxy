import 'dotenv/config';
import axios from 'axios';
import FormData from 'form-data';
import { Worker, RateLimiterWorker } from 'bullmq';
import { connection } from './queue.js';

const MAILGUN_BASE_URL = process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net';
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const TARGET_PER_HOUR = parseInt(process.env.TARGET_PER_HOUR || '200', 10);
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '10', 10);

// ceil(TARGET_PER_HOUR / CHUNK_SIZE) jobs per hour = TARGET_PER_HOUR recipients/hour
const jobsPerHour = Math.ceil(TARGET_PER_HOUR / CHUNK_SIZE);

const worker = new Worker(
  'mail-chunks',
  async (job) => {
    const { domain, to, recipientVariables, fields, files, batchId } = job.data;

    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (Array.isArray(v)) {
        for (const item of v) form.append(k, item);
      } else {
        form.append(k, v);
      }
    }
    for (const email of to) form.append('to', email);
    if (Object.keys(recipientVariables).length > 0) {
      form.append('recipient-variables', JSON.stringify(recipientVariables));
    }
    for (const file of files) {
      form.append(file.fieldname, Buffer.from(file.buffer, 'base64'), {
        filename: file.originalname,
        contentType: file.mimetype,
      });
    }

    const response = await axios.post(
      `${MAILGUN_BASE_URL}/v3/${domain}/messages`,
      form,
      {
        headers: form.getHeaders(),
        auth: { username: 'api', password: MAILGUN_API_KEY },
      }
    );

    console.log(`[sent] batchId=${batchId} to=${to.join(',')} mailgunId=${response.data.id}`);
    return response.data;
  },
  {
    connection,
    limiter: {
      max: jobsPerHour,
      duration: 60 * 60 * 1000, // 1 hour in ms
    },
    concurrency: 1,
  }
);

worker.on('failed', (job, err) => {
  console.error(`[failed] jobId=${job?.id} batchId=${job?.data?.batchId} err=${err.message}`);
});

console.log(`worker started — rate limit: ${jobsPerHour} jobs/hour (~${TARGET_PER_HOUR} recipients/hour)`);
