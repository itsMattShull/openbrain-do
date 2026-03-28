'use strict';

const { z } = require('zod');

module.exports = {
  name: 'professional-crm',

  tools: [
    // ── Contacts ────────────────────────────────────────────────────────────

    {
      name: 'add_professional_contact',
      config: {
        title: 'Add Professional Contact',
        description: 'Add a professional contact to your network. Use tags to categorize (e.g. investor, customer, recruiter, advisor). how_met helps you remember context.',
        inputSchema: {
          name: z.string().describe('Full name'),
          company: z.string().optional(),
          title: z.string().optional().describe('Job title'),
          email: z.string().optional(),
          phone: z.string().optional(),
          linkedin_url: z.string().optional(),
          how_met: z.string().optional().describe('Where/how you met this person'),
          tags: z.array(z.string()).optional().describe('e.g. ["investor", "advisor"]'),
          notes: z.string().optional(),
        },
      },
      async handler({ name, company, title, email, phone, linkedin_url, how_met, tags, notes }, context) {
        try {
          const { rows } = await context.pool.query(
            `INSERT INTO professional_contacts (name, company, title, email, phone, linkedin_url, how_met, tags, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, name, company`,
            [name, company || null, title || null, email || null, phone || null,
             linkedin_url || null, how_met || null, tags || null, notes || null]
          );
          const c = rows[0];
          let msg = `Added ${c.name}`;
          if (c.company) msg += ` at ${c.company}`;
          msg += ` — ID: ${c.id}`;
          return { content: [{ type: 'text', text: msg }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'search_contacts',
      config: {
        title: 'Search Contacts',
        description: 'Search your professional network by name, company, or tag.',
        inputSchema: {
          query: z.string().optional().describe('Search name or company'),
          tag: z.string().optional().describe('Filter by a specific tag'),
          limit: z.number().optional().default(10),
        },
      },
      async handler({ query, tag, limit }, context) {
        try {
          const conditions = [];
          const params = [];

          if (query) {
            params.push(`%${query}%`);
            conditions.push(`(name ILIKE $${params.length} OR company ILIKE $${params.length})`);
          }
          if (tag) {
            params.push(tag);
            conditions.push(`$${params.length} = ANY(tags)`);
          }

          params.push(limit ?? 10);
          const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
          const { rows } = await context.pool.query(
            `SELECT id, name, company, title, email, tags, last_contacted, notes
             FROM professional_contacts ${where}
             ORDER BY name LIMIT $${params.length}`,
            params
          );

          if (!rows.length) return { content: [{ type: 'text', text: 'No contacts found.' }] };
          const lines = rows.map((c) => {
            const parts = [`• ${c.name}`];
            if (c.title) parts.push(`(${c.title}`);
            if (c.company) parts.push(c.title ? `@ ${c.company})` : `(${c.company})`);
            else if (c.title) parts.push(')');
            if (c.email) parts.push(`<${c.email}>`);
            if (Array.isArray(c.tags) && c.tags.length) parts.push(`[${c.tags.join(', ')}]`);
            if (c.last_contacted) parts.push(`last: ${new Date(c.last_contacted).toLocaleDateString()}`);
            return parts.join(' ');
          });
          return { content: [{ type: 'text', text: `${rows.length} contact(s):\n\n${lines.join('\n')}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    // ── Interactions ────────────────────────────────────────────────────────

    {
      name: 'log_interaction',
      config: {
        title: 'Log Interaction',
        description: 'Record a touchpoint with a professional contact. Automatically updates their last_contacted timestamp. interaction_type: meeting, email, call, coffee, event, linkedin, other.',
        inputSchema: {
          contact_name: z.string().describe('Name of the contact (matched by name, case-insensitive)'),
          interaction_type: z.enum(['meeting', 'email', 'call', 'coffee', 'event', 'linkedin', 'other']),
          summary: z.string().optional().describe('What was discussed or what happened'),
          needs_follow_up: z.boolean().optional().default(false),
          follow_up_date: z.string().optional().describe('YYYY-MM-DD — when to follow up'),
        },
      },
      async handler({ contact_name, interaction_type, summary, needs_follow_up, follow_up_date }, context) {
        try {
          // Look up contact by name
          const { rows: contacts } = await context.pool.query(
            `SELECT id, name FROM professional_contacts WHERE LOWER(name) = LOWER($1) LIMIT 1`,
            [contact_name]
          );
          if (!contacts.length) {
            return { content: [{ type: 'text', text: `No contact found named "${contact_name}". Add them first with add_professional_contact.` }], isError: true };
          }
          const contact = contacts[0];

          const { rows } = await context.pool.query(
            `INSERT INTO contact_interactions (contact_id, interaction_type, summary, needs_follow_up, follow_up_date)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, created_at`,
            [contact.id, interaction_type, summary || null, needs_follow_up || false, follow_up_date || null]
          );

          let msg = `Logged ${interaction_type} with ${contact.name}`;
          if (needs_follow_up && follow_up_date) msg += ` — follow up by ${follow_up_date}`;
          else if (needs_follow_up) msg += ` — needs follow-up`;
          return { content: [{ type: 'text', text: msg }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'get_follow_ups_due',
      config: {
        title: 'Get Follow-Ups Due',
        description: 'Return contacts that have pending follow-ups — either with a follow_up_date within the next N days, or marked needs_follow_up with no date set.',
        inputSchema: {
          days: z.number().optional().default(7).describe('Look-ahead window in days (default 7)'),
        },
      },
      async handler({ days }, context) {
        try {
          const { rows } = await context.pool.query(
            `SELECT
               pc.name, pc.company, pc.email,
               ci.interaction_type, ci.summary, ci.follow_up_date, ci.created_at AS interaction_date
             FROM contact_interactions ci
             JOIN professional_contacts pc ON pc.id = ci.contact_id
             WHERE ci.needs_follow_up = true
               AND (
                 ci.follow_up_date IS NULL
                 OR ci.follow_up_date <= CURRENT_DATE + $1::int
               )
             ORDER BY ci.follow_up_date NULLS FIRST, pc.name`,
            [days ?? 7]
          );

          if (!rows.length) return { content: [{ type: 'text', text: 'No follow-ups due.' }] };
          const lines = rows.map((r) => {
            const parts = [`• ${r.name}`];
            if (r.company) parts.push(`(${r.company})`);
            parts.push(`— last: ${r.interaction_type}`);
            if (r.follow_up_date) parts.push(`| follow up by ${r.follow_up_date}`);
            else parts.push(`| no date set`);
            if (r.summary) parts.push(`| "${r.summary}"`);
            return parts.join(' ');
          });
          return { content: [{ type: 'text', text: `${rows.length} follow-up(s) due:\n\n${lines.join('\n')}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    // ── Opportunities ───────────────────────────────────────────────────────

    {
      name: 'create_opportunity',
      config: {
        title: 'Create Opportunity',
        description: 'Track a professional opportunity (deal, partnership, job, etc.) tied to a contact. Stages: identified, exploring, proposal, negotiating, won, lost.',
        inputSchema: {
          contact_name: z.string().describe('Name of the associated contact'),
          title: z.string().describe('Opportunity name, e.g. "Series A intro via Jane"'),
          description: z.string().optional(),
          stage: z.enum(['identified', 'exploring', 'proposal', 'negotiating', 'won', 'lost']).optional().default('identified'),
          value: z.number().optional().describe('Estimated monetary value'),
          close_date: z.string().optional().describe('Target close date YYYY-MM-DD'),
          notes: z.string().optional(),
        },
      },
      async handler({ contact_name, title, description, stage, value, close_date, notes }, context) {
        try {
          const { rows: contacts } = await context.pool.query(
            `SELECT id, name FROM professional_contacts WHERE LOWER(name) = LOWER($1) LIMIT 1`,
            [contact_name]
          );
          if (!contacts.length) {
            return { content: [{ type: 'text', text: `No contact found named "${contact_name}". Add them first with add_professional_contact.` }], isError: true };
          }

          const { rows } = await context.pool.query(
            `INSERT INTO opportunities (contact_id, title, description, stage, value, close_date, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, title, stage`,
            [contacts[0].id, title, description || null, stage || 'identified',
             value || null, close_date || null, notes || null]
          );
          const opp = rows[0];
          return { content: [{ type: 'text', text: `Created opportunity "${opp.title}" [${opp.stage}] with ${contacts[0].name} — ID: ${opp.id}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    // ── Cross-extension bridge ───────────────────────────────────────────────

    {
      name: 'link_thought_to_contact',
      config: {
        title: 'Link Thought to Contact',
        description: 'Attach an Open Brain thought ID to a contact\'s notes, bridging raw captures to your CRM. Use this after capturing a thought about someone to keep their record current.',
        inputSchema: {
          contact_name: z.string().describe('Name of the contact'),
          thought_id: z.string().describe('UUID of the thought from the thoughts table'),
          context_note: z.string().optional().describe('Brief note explaining the connection'),
        },
      },
      async handler({ contact_name, thought_id, context_note }, context) {
        try {
          // Verify the thought exists
          const { rows: thoughts } = await context.pool.query(
            `SELECT id, content FROM thoughts WHERE id = $1 LIMIT 1`,
            [thought_id]
          );
          if (!thoughts.length) {
            return { content: [{ type: 'text', text: `No thought found with ID "${thought_id}".` }], isError: true };
          }

          // Find the contact
          const { rows: contacts } = await context.pool.query(
            `SELECT id, name, notes FROM professional_contacts WHERE LOWER(name) = LOWER($1) LIMIT 1`,
            [contact_name]
          );
          if (!contacts.length) {
            return { content: [{ type: 'text', text: `No contact found named "${contact_name}".` }], isError: true };
          }
          const contact = contacts[0];

          // Append the link to notes
          const linkEntry = `[Thought ${thought_id}${context_note ? `: ${context_note}` : ''}]`;
          const updatedNotes = contact.notes ? `${contact.notes}\n${linkEntry}` : linkEntry;

          await context.pool.query(
            `UPDATE professional_contacts SET notes = $1 WHERE id = $2`,
            [updatedNotes, contact.id]
          );

          return { content: [{ type: 'text', text: `Linked thought to ${contact.name}. Thought preview: "${thoughts[0].content.slice(0, 80)}${thoughts[0].content.length > 80 ? '…' : ''}"` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },
  ],
};
