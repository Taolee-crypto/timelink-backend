-- Replace the manual-only approval trigger with an evidence-bound AI approval path.
-- Manual approval continues to require a reviewer; rejections remain manual.
DROP TRIGGER IF EXISTS v5_music_gate_approval_requires_reviewer;
CREATE TRIGGER v5_music_gate_approval_requires_reviewer
BEFORE UPDATE OF status ON v5_music_gate_reviews
WHEN NEW.status='approved' AND (
  NEW.decided_at IS NULL OR (
    NEW.reviewer_user_id IS NULL AND NOT (
      OLD.status='analyzing'
      AND NEW.analysis_error IS NULL
      AND NEW.source_sha256=OLD.source_sha256
      AND json_valid(NEW.evidence_json)
      AND json_extract(NEW.evidence_json,'$.automatic_approval')=1
      AND json_extract(NEW.evidence_json,'$.analysis_complete')=1
      AND json_extract(NEW.evidence_json,'$.source_sha256')=NEW.source_sha256
      AND json_extract(NEW.evidence_json,'$.audio_analysis.audio_understood')=1
      AND json_extract(NEW.evidence_json,'$.audio_analysis.full_audio_reviewed')=1
      AND json_extract(NEW.evidence_json,'$.audio_analysis.unsafe_content')='clear'
      AND CAST(json_extract(NEW.evidence_json,'$.audio_analysis.music_probability') AS REAL)>=0.98
      AND json_array_length(json_extract(NEW.evidence_json,'$.audio_analysis.risk_signals'))=0
      AND json_extract(NEW.evidence_json,'$.auto_approval_basis')='verified_source_hash_and_complete_ai_audio_screening'
    )
  )
)
BEGIN SELECT RAISE(ABORT,'MUSIC_GATE_APPROVAL_REQUIRES_VERIFIED_AI_OR_REVIEWER'); END;
