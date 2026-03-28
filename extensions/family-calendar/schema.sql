CREATE TABLE IF NOT EXISTS family_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  relationship TEXT,
  birth_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_members_name ON family_members (name);

CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  activity_type TEXT,
  day_of_week TEXT,
  start_time TIME,
  end_time TIME,
  location TEXT,
  assigned_to TEXT,
  recurring BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activities_assigned ON activities (assigned_to);
CREATE INDEX IF NOT EXISTS idx_activities_day ON activities (day_of_week);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities (activity_type);

CREATE TABLE IF NOT EXISTS important_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  date DATE NOT NULL,
  yearly BOOLEAN DEFAULT true,
  reminder_days INT DEFAULT 7,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_important_dates_date ON important_dates (date);
