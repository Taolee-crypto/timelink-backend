-- One station cannot bill the same wall-clock interval twice under different
-- event IDs or tracks. Replays of the original event remain idempotent.
CREATE TRIGGER IF NOT EXISTS tilo_v5_airtime_no_overlap
BEFORE INSERT ON tilo_v5_verified_airtime
WHEN EXISTS (
 SELECT 1 FROM tilo_v5_verified_airtime e
 WHERE e.service_id=NEW.service_id AND e.country=NEW.country
   AND e.event_id<>NEW.event_id
   AND julianday(e.started_at)<julianday(NEW.ended_at)
   AND julianday(e.ended_at)>julianday(NEW.started_at)
)
BEGIN
 SELECT RAISE(ABORT,'TILO_AIRTIME_INTERVAL_OVERLAP');
END;
