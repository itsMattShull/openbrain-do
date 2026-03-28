CREATE TABLE IF NOT EXISTS professional_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  company TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  how_met TEXT,
  tags TEXT[],
  notes TEXT,
  last_contacted TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_name ON professional_contacts (name);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON professional_contacts (company);
CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted ON professional_contacts (last_contacted);

CREATE TABLE IF NOT EXISTS contact_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES professional_contacts(id) ON DELETE CASCADE,
  interaction_type TEXT NOT NULL,
  summary TEXT,
  needs_follow_up BOOLEAN DEFAULT false,
  follow_up_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_interactions_contact ON contact_interactions (contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_follow_up ON contact_interactions (follow_up_date)
  WHERE needs_follow_up = true;

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES professional_contacts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  stage TEXT DEFAULT 'identified',
  value NUMERIC,
  close_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_contact ON opportunities (contact_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities (stage);

-- Auto-update last_contacted when an interaction is logged
CREATE OR REPLACE FUNCTION update_last_contacted()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE professional_contacts SET last_contacted = NEW.created_at WHERE id = NEW.contact_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_last_contacted ON contact_interactions;
CREATE TRIGGER trg_update_last_contacted
  AFTER INSERT ON contact_interactions
  FOR EACH ROW EXECUTE FUNCTION update_last_contacted();
