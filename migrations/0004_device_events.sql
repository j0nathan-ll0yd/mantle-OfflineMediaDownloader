CREATE TABLE IF NOT EXISTS device_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  properties TEXT,
  correlation_id UUID,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT device_events_device_correlation_unique UNIQUE (device_id, correlation_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_events_device_idx ON device_events (device_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_events_received_at_idx ON device_events (received_at);
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP WITH TIME ZONE;
