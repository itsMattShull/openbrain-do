'use strict';

const { z } = require('zod');

module.exports = {
  name: 'family-calendar',

  tools: [
    // ── Family Members ──────────────────────────────────────────────────────

    {
      name: 'add_family_member',
      config: {
        title: 'Add Family Member',
        description: 'Register a household or family member. Use this to build the roster of people whose schedules you track.',
        inputSchema: {
          name: z.string().describe('Full name'),
          relationship: z.string().optional().describe('e.g. spouse, child, parent, sibling'),
          birth_date: z.string().optional().describe('YYYY-MM-DD'),
          notes: z.string().optional().describe('Any notes about this person'),
        },
      },
      async handler({ name, relationship, birth_date, notes }, context) {
        try {
          const { rows } = await context.pool.query(
            `INSERT INTO family_members (name, relationship, birth_date, notes)
             VALUES ($1, $2, $3, $4)
             RETURNING id, name, relationship`,
            [name, relationship || null, birth_date || null, notes || null]
          );
          const m = rows[0];
          return {
            content: [{ type: 'text', text: `Added ${m.name}${m.relationship ? ` (${m.relationship})` : ''} — ID: ${m.id}` }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'list_family_members',
      config: {
        title: 'List Family Members',
        description: 'List all registered family/household members.',
        inputSchema: {},
      },
      async handler(_args, context) {
        try {
          const { rows } = await context.pool.query(
            `SELECT id, name, relationship, birth_date, notes FROM family_members ORDER BY name`
          );
          if (!rows.length) return { content: [{ type: 'text', text: 'No family members registered yet.' }] };
          const lines = rows.map((m) => {
            const parts = [`• ${m.name}`];
            if (m.relationship) parts.push(`(${m.relationship})`);
            if (m.birth_date) parts.push(`b. ${new Date(m.birth_date).toLocaleDateString()}`);
            if (m.notes) parts.push(`— ${m.notes}`);
            return parts.join(' ');
          });
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    // ── Activities ──────────────────────────────────────────────────────────

    {
      name: 'add_activity',
      config: {
        title: 'Add Activity',
        description: 'Add a scheduled activity for a family member. Can be one-time or recurring (weekly). Use activity_type to categorize: sports, medical, school, work, social, other.',
        inputSchema: {
          title: z.string().describe('Activity name, e.g. "Soccer practice"'),
          assigned_to: z.string().optional().describe('Family member name this activity belongs to'),
          activity_type: z.string().optional().describe('sports, medical, school, work, social, other'),
          day_of_week: z.string().optional().describe('Monday, Tuesday, etc. (for recurring) or a specific date YYYY-MM-DD'),
          start_time: z.string().optional().describe('HH:MM (24h)'),
          end_time: z.string().optional().describe('HH:MM (24h)'),
          location: z.string().optional(),
          recurring: z.boolean().optional().default(false).describe('true if this repeats weekly'),
          notes: z.string().optional(),
        },
      },
      async handler({ title, assigned_to, activity_type, day_of_week, start_time, end_time, location, recurring, notes }, context) {
        try {
          const { rows } = await context.pool.query(
            `INSERT INTO activities (title, assigned_to, activity_type, day_of_week, start_time, end_time, location, recurring, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, title, assigned_to, day_of_week`,
            [
              title,
              assigned_to || null,
              activity_type || null,
              day_of_week || null,
              start_time || null,
              end_time || null,
              location || null,
              recurring || false,
              notes || null,
            ]
          );
          const a = rows[0];
          let msg = `Added "${a.title}"`;
          if (a.assigned_to) msg += ` for ${a.assigned_to}`;
          if (a.day_of_week) msg += ` on ${a.day_of_week}`;
          msg += ` — ID: ${a.id}`;
          return { content: [{ type: 'text', text: msg }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'get_week_schedule',
      config: {
        title: 'Get Week Schedule',
        description: 'Get the weekly activity schedule, optionally filtered to one family member.',
        inputSchema: {
          assigned_to: z.string().optional().describe('Filter to a specific family member by name'),
        },
      },
      async handler({ assigned_to }, context) {
        try {
          const params = [];
          let where = '';
          if (assigned_to) {
            params.push(assigned_to);
            where = `WHERE LOWER(assigned_to) = LOWER($1)`;
          }
          const { rows } = await context.pool.query(
            `SELECT title, assigned_to, activity_type, day_of_week, start_time, end_time, location, recurring, notes
             FROM activities ${where}
             ORDER BY
               CASE day_of_week
                 WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
                 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
                 WHEN 'Sunday' THEN 7 ELSE 8 END,
               start_time NULLS LAST`,
            params
          );
          if (!rows.length) return { content: [{ type: 'text', text: 'No activities found.' }] };
          const lines = rows.map((a) => {
            const parts = [`[${a.day_of_week || 'Date TBD'}]`];
            if (a.start_time) parts.push(`${a.start_time}${a.end_time ? `–${a.end_time}` : ''}`);
            parts.push(a.title);
            if (a.assigned_to) parts.push(`(${a.assigned_to})`);
            if (a.location) parts.push(`@ ${a.location}`);
            if (a.recurring) parts.push('[recurring]');
            return parts.join(' ');
          });
          return { content: [{ type: 'text', text: `${rows.length} activity/activities:\n\n${lines.join('\n')}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'search_activities',
      config: {
        title: 'Search Activities',
        description: 'Search activities by title keyword, type, or family member name.',
        inputSchema: {
          query: z.string().optional().describe('Keyword to search in title or notes'),
          activity_type: z.string().optional().describe('Filter by type: sports, medical, school, work, social, other'),
          assigned_to: z.string().optional().describe('Filter by family member name'),
        },
      },
      async handler({ query, activity_type, assigned_to }, context) {
        try {
          const conditions = [];
          const params = [];

          if (query) {
            params.push(`%${query}%`);
            conditions.push(`(title ILIKE $${params.length} OR notes ILIKE $${params.length})`);
          }
          if (activity_type) {
            params.push(activity_type);
            conditions.push(`activity_type = $${params.length}`);
          }
          if (assigned_to) {
            params.push(assigned_to);
            conditions.push(`LOWER(assigned_to) = LOWER($${params.length})`);
          }

          const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
          const { rows } = await context.pool.query(
            `SELECT title, assigned_to, activity_type, day_of_week, start_time, location, recurring
             FROM activities ${where} ORDER BY title`,
            params
          );

          if (!rows.length) return { content: [{ type: 'text', text: 'No matching activities found.' }] };
          const lines = rows.map((a) => {
            const parts = [`• "${a.title}"`];
            if (a.activity_type) parts.push(`[${a.activity_type}]`);
            if (a.assigned_to) parts.push(`— ${a.assigned_to}`);
            if (a.day_of_week) parts.push(`on ${a.day_of_week}`);
            if (a.start_time) parts.push(`at ${a.start_time}`);
            if (a.location) parts.push(`@ ${a.location}`);
            return parts.join(' ');
          });
          return { content: [{ type: 'text', text: `${rows.length} result(s):\n\n${lines.join('\n')}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    // ── Important Dates ─────────────────────────────────────────────────────

    {
      name: 'add_important_date',
      config: {
        title: 'Add Important Date',
        description: 'Record a birthday, anniversary, deadline, or other important date. Set yearly=true for recurring annual events.',
        inputSchema: {
          title: z.string().describe('e.g. "Mom\'s birthday", "Wedding anniversary"'),
          date: z.string().describe('YYYY-MM-DD'),
          yearly: z.boolean().optional().default(true).describe('Recurs every year'),
          reminder_days: z.number().optional().default(7).describe('Days before to surface as upcoming'),
          notes: z.string().optional(),
        },
      },
      async handler({ title, date, yearly, reminder_days, notes }, context) {
        try {
          const { rows } = await context.pool.query(
            `INSERT INTO important_dates (title, date, yearly, reminder_days, notes)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, title, date`,
            [title, date, yearly !== false, reminder_days ?? 7, notes || null]
          );
          const d = rows[0];
          return {
            content: [{ type: 'text', text: `Added "${d.title}" on ${d.date} — ID: ${d.id}` }],
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },

    {
      name: 'get_upcoming_dates',
      config: {
        title: 'Get Upcoming Important Dates',
        description: 'Fetch important dates coming up within the next N days (default 30). Accounts for yearly recurrence — birthdays and anniversaries are returned even if the stored year is past.',
        inputSchema: {
          days: z.number().optional().default(30).describe('Look-ahead window in days'),
        },
      },
      async handler({ days }, context) {
        try {
          const lookAhead = days ?? 30;
          // For yearly events, compare month+day against the current year window
          const { rows } = await context.pool.query(
            `SELECT title, date, yearly, reminder_days, notes
             FROM important_dates
             WHERE
               (yearly = false AND date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int)
               OR
               (yearly = true AND
                 make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, EXTRACT(MONTH FROM date)::int, EXTRACT(DAY FROM date)::int)
                 BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int)
             ORDER BY
               CASE WHEN yearly THEN
                 make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int, EXTRACT(MONTH FROM date)::int, EXTRACT(DAY FROM date)::int)
               ELSE date END`,
            [lookAhead]
          );

          if (!rows.length) return { content: [{ type: 'text', text: `No important dates in the next ${lookAhead} day(s).` }] };
          const lines = rows.map((d) => {
            const displayDate = d.yearly
              ? `${String(new Date(d.date).getUTCMonth() + 1).padStart(2, '0')}/${String(new Date(d.date).getUTCDate()).padStart(2, '0')}`
              : new Date(d.date).toLocaleDateString();
            const parts = [`• ${displayDate} — ${d.title}`];
            if (d.yearly) parts.push('[yearly]');
            if (d.notes) parts.push(`(${d.notes})`);
            return parts.join(' ');
          });
          return { content: [{ type: 'text', text: `${rows.length} upcoming date(s):\n\n${lines.join('\n')}` }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
        }
      },
    },
  ],
};
