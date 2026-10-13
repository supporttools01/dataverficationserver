CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  balance NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  price_per_10000 NUMERIC(18,6) NOT NULL DEFAULT 4 CHECK (price_per_10000 >= 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  provider_mode TEXT NOT NULL DEFAULT 'demo' CHECK (provider_mode IN ('demo','authorized')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'N/A',
  input_filename TEXT,
  input_data TEXT NOT NULL DEFAULT '',
  input_count INTEGER NOT NULL DEFAULT 0 CHECK (input_count >= 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','complete','failed')),
  mode TEXT NOT NULL DEFAULT 'demo' CHECK (mode IN ('demo','authorized')),
  cost NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  result_filename TEXT,
  result_data TEXT,
  result_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  task_id UUID REFERENCES tasks(id),
  amount NUMERIC(18,6) NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('credit','debit','refund','adjustment')),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO products (id,name,description,category,price_per_10000,provider_mode) VALUES
('ios-status','iOS Status Workflow','Task intake and result-file management for authorized status datasets. No live Apple status check is provided by default.','iOS',4,'demo'),
('ios-dynamic','iOS Dynamic Status Workflow','Separate workflow for datasets covered by an authorized provider contract. Demo mode until configured.','iOS',4,'demo'),
('txt-validation','TXT File Validation','Local line, blank-row and duplicate validation. No provider call.','File tools',0,'demo'),
('csv-validation','CSV File Validation','Local CSV structure and required-column validation.','File tools',0,'demo'),
('number-format','Phone Number Format Audit','Syntax/format validation only; does not establish account status.','Data quality',0,'demo'),
('email-format','Email Format Audit','Syntax validation only; does not establish account existence or mailbox status.','Data quality',0,'demo'),
('data-dedup','Duplicate Record Cleanup','Remove duplicate rows from a supplied authorized dataset.','Data quality',0,'demo'),
('custom-batch','Custom Batch Processing','Admin-configured batch intake with downloadable outputs. Demo mode by default.','Batch tools',4,'demo')
ON CONFLICT (id) DO NOTHING;
