'use strict';

const crypto = require('crypto');
const { pool, formatVector } = require('./db');
const { getEmbedding, extractMetadata } = require('./utils');

const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Ed25519 SPKI DER header — wraps a raw 32-byte public key so Node crypto can use it
const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

function verifyDiscordSignature(signature, timestamp, rawBody) {
  if (!signature || !timestamp) return false;
  try {
    const rawKey = Buffer.from(DISCORD_PUBLIC_KEY, 'hex');
    const spkiDer = Buffer.concat([SPKI_HEADER, rawKey]);
    const keyObject = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const message = Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]);
    const sig = Buffer.from(signature, 'hex');
    return crypto.verify(null, message, keyObject, sig);
  } catch {
    return false;
  }
}

async function sendFollowup(applicationId, interactionToken, content) {
  await fetch(`${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

// Express route handler — use express.text({ type: 'application/json' }) upstream
// so req.body is the raw JSON string (needed for Discord signature verification)
async function handleIngest(req, res) {
  try {
    const rawBody = req.body; // raw string, not parsed yet
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];

    if (!verifyDiscordSignature(signature, timestamp, rawBody)) {
      return res.status(401).send('Invalid request signature');
    }

    const body = JSON.parse(rawBody);

    // Discord PING — required for endpoint verification in the developer portal
    if (body.type === 1) {
      return res.json({ type: 1 });
    }

    // Must be a /capture slash command
    if (body.type !== 2 || body.data?.name !== 'capture') {
      return res.json({ type: 1 });
    }

    const thought = body.data.options?.find((o) => o.name === 'thought')?.value;

    if (!thought || thought.trim() === '') {
      return res.json({ type: 4, data: { content: 'Please provide a thought to capture.', flags: 64 } });
    }

    const applicationId = body.application_id;
    const interactionToken = body.token;
    const discordUserId = body.member?.user?.id ?? body.user?.id;

    // Respond with deferred message immediately (Discord requires < 3s)
    res.json({ type: 5, data: { flags: 64 } });

    // Background: generate embedding + metadata + insert
    (async () => {
      try {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(thought),
          extractMetadata(thought),
        ]);

        const fullMetadata = { ...metadata, source: 'discord', discord_user_id: discordUserId };

        await pool.query(
          'INSERT INTO thoughts (content, embedding, metadata) VALUES ($1, $2::vector, $3)',
          [thought, formatVector(embedding), JSON.stringify(fullMetadata)]
        );

        let confirmation = `✅ Captured as **${metadata.type || 'thought'}**`;
        if (Array.isArray(metadata.topics) && metadata.topics.length)
          confirmation += ` — ${metadata.topics.join(', ')}`;
        if (Array.isArray(metadata.people) && metadata.people.length)
          confirmation += `\n👤 People: ${metadata.people.join(', ')}`;
        if (Array.isArray(metadata.action_items) && metadata.action_items.length)
          confirmation += `\n✔️ Action items: ${metadata.action_items.join('; ')}`;

        await sendFollowup(applicationId, interactionToken, confirmation);
      } catch (err) {
        console.error('Background ingest error:', err);
        await sendFollowup(applicationId, interactionToken, '❌ Something went wrong while capturing your thought.');
      }
    })();

  } catch (err) {
    console.error('Ingest handler error:', err);
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
}

module.exports = { handleIngest };
