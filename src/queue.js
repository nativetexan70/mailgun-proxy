import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const connection = new IORedis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
});

export const mailQueue = new Queue('mail-chunks', { connection });
