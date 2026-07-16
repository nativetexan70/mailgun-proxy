import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { mailQueue } from './queue.js';

const app = express();
const upload = multer();

const PROXY_API_KEY = process.env.PROXY_API_KEY;
const MAILGUN_BASE_URL = process.env.MAILGUN_BASE_URL || 'https://api.mailgun.net';
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '10', 10);

function checkAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const encoded = auth.replace(/^Basic\s+/i, '');
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const [, key] = decoded.split(':');
  if (!PROXY_API_KEY || key !== PROXY_API_KEY) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
}

// Accept Ghost's bulk send
app.post('/v3/:domain/messages', checkAuth, upload.any(), async (req, res) => {
  const { domain } = req.params;
  const fields = req.body;
  const files = req.files || [];

  // Ghost sends 'to' as a comma-separated string or repeated fields
  const toRaw = fields['to'];
  const recipients = (Array.isArray(toRaw) ? toRaw : [toRaw])
    .flatMap(r => r.split(',').map(s => s.trim()))
    .filter(Boolean);

  // recipient-variables is a JSON string keyed by email
  let recipientVariables = {};
  try {
    recipientVariables = JSON.parse(fields['recipient-variables'] || '{}');
  } catch {
    // ignore parse errors — treat as empty
  }

  const batchId = uuidv4();
  const chunks = [];
  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    chunks.push(recipients.slice(i, i + CHUNK_SIZE));
  }

  // Base message fields minus 'to' and 'recipient-variables'
  const baseFields = { ...fields };
  delete baseFields['to'];
  delete baseFields['recipient-variables'];

  for (const chunk of chunks) {
    const chunkVars = {};
    for (const email of chunk) {
      if (recipientVariables[email]) chunkVars[email] = recipientVariables[email];
    }
    await mailQueue.add('send-chunk', {
      domain,
      to: chunk,
      recipientVariables: chunkVars,
      fields: baseFields,
      files: files.map(f => ({
        fieldname: f.fieldname,
        originalname: f.originalname,
        mimetype: f.mimetype,
        buffer: f.buffer.toString('base64'),
      })),
      batchId,
    });
  }

  console.log(`[queued] batchId=${batchId} recipients=${recipients.length} chunks=${chunks.length}`);

  res.status(200).json({
    id: `<${batchId}@${domain}>`,
    message: 'Queued. Thank you.',
  });
});

// Pass events endpoint straight through to real Mailgun
app.get('/v3/:domain/events', checkAuth, async (req, res) => {
  const { domain } = req.params;
  try {
    const response = await axios.get(
      `${MAILGUN_BASE_URL}/v3/${domain}/events`,
      {
        params: req.query,
        auth: { username: 'api', password: MAILGUN_API_KEY },
        responseType: 'json',
      }
    );
    res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status).json(err.response?.data || { message: 'upstream error' });
  }
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => console.log(`proxy listening on :${PORT}`));
