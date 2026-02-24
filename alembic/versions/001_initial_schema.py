"""Initial TimeLink schema

Revision ID: 001
Revises:
Create Date: 2026-02-24
"""
from alembic import op
import sqlalchemy as sa

revision = '001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── users ──
    op.create_table('users',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('email', sa.String(), nullable=False, unique=True, index=True),
        sa.Column('username', sa.String(), nullable=False, unique=True, index=True),
        sa.Column('password_hash', sa.String(), nullable=False),
        sa.Column('tl_balance', sa.Float(), default=0.0, nullable=False),
        sa.Column('tl_locked', sa.Float(), default=0.0, nullable=False),
        sa.Column('tlc_balance', sa.Float(), default=0.0, nullable=False),
        sa.Column('total_tl_spent', sa.Float(), default=0.0, nullable=False),
        sa.Column('total_tl_earned', sa.Float(), default=0.0, nullable=False),
        sa.Column('total_tl_exchanged', sa.Float(), default=0.0, nullable=False),
        sa.Column('poc_index', sa.Float(), default=1.0, nullable=False),
        sa.Column('false_dispute_strikes', sa.Integer(), default=0, nullable=False),
        sa.Column('account_forfeited', sa.Boolean(), default=False, nullable=False),
        sa.Column('tl_suspended', sa.Boolean(), default=False, nullable=False),
        sa.Column('is_active', sa.Boolean(), default=True, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    # ── tl_files ──
    op.create_table('tl_files',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False, index=True),
        sa.Column('title', sa.String(), nullable=False),
        sa.Column('artist', sa.String(), default=''),
        sa.Column('genre', sa.String(), default=''),
        sa.Column('country', sa.String(), default='kr'),
        sa.Column('file_type', sa.String(), default='audio'),
        sa.Column('file_url', sa.String(), nullable=False),
        sa.Column('file_size_bytes', sa.Integer(), default=0),
        sa.Column('duration_seconds', sa.Integer(), default=0),
        sa.Column('file_tl', sa.Float(), default=0.0),
        sa.Column('max_file_tl', sa.Float(), default=0.0),
        sa.Column('revenue', sa.Float(), default=0.0),
        sa.Column('hold_revenue', sa.Float(), default=0.0),
        sa.Column('auth_status', sa.String(), default='unverified'),
        sa.Column('auth_type', sa.String(), nullable=True),
        sa.Column('auth_proof_url', sa.String(), nullable=True),
        sa.Column('revenue_started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('shared', sa.Boolean(), default=False),
        sa.Column('pulse', sa.Integer(), default=0),
        sa.Column('play_count', sa.Integer(), default=0),
        sa.Column('revenue_held', sa.Boolean(), default=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    # ── transactions ──
    op.create_table('transactions',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False, index=True),
        sa.Column('file_id', sa.Integer(), sa.ForeignKey('tl_files.id'), nullable=True),
        sa.Column('tx_type', sa.String(), nullable=False),
        sa.Column('amount', sa.Float(), nullable=False),
        sa.Column('balance_after', sa.Float(), nullable=False),
        sa.Column('description', sa.String(), default=''),
        sa.Column('counterpart_user_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), index=True),
    )

    # ── auth_requests ──
    op.create_table('auth_requests',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('file_id', sa.Integer(), sa.ForeignKey('tl_files.id'), nullable=False, index=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('source_url', sa.String(), nullable=True),
        sa.Column('profile_url', sa.String(), nullable=True),
        sa.Column('capture_path', sa.String(), nullable=True),
        sa.Column('payment_proof_path', sa.String(), nullable=True),
        sa.Column('email_proof', sa.String(), nullable=True),
        sa.Column('plan_type', sa.String(), nullable=True),
        sa.Column('creation_month', sa.String(), nullable=True),
        sa.Column('extra_notes', sa.Text(), nullable=True),
        sa.Column('status', sa.String(), default='pending'),
        sa.Column('ocr_result', sa.Text(), nullable=True),
        sa.Column('reviewer_note', sa.Text(), nullable=True),
        sa.Column('reviewed_by', sa.Integer(), nullable=True),
        sa.Column('submitted_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
    )

    # ── play_events ──
    op.create_table('play_events',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('file_id', sa.Integer(), sa.ForeignKey('tl_files.id'), nullable=False, index=True),
        sa.Column('player_user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=True),
        sa.Column('tl_deducted', sa.Float(), default=0.0),
        sa.Column('revenue_credited', sa.Float(), default=0.0),
        sa.Column('file_tl_after', sa.Float(), default=0.0),
        sa.Column('play_duration_seconds', sa.Integer(), default=0),
        sa.Column('car_mode', sa.Boolean(), default=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), index=True),
    )

    # ── disputes ──
    op.create_table('disputes',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('file_id', sa.Integer(), sa.ForeignKey('tl_files.id'), nullable=False, index=True),
        sa.Column('disputer_user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False, index=True),
        sa.Column('category', sa.String(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('evidence_paths', sa.Text(), default='[]'),
        sa.Column('status', sa.String(), default='pending'),
        sa.Column('result_note', sa.Text(), nullable=True),
        sa.Column('days_remaining', sa.Integer(), default=30),
        sa.Column('false_strike_added', sa.Boolean(), default=False),
        sa.Column('poc_delta_applied', sa.Float(), default=0.0),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
    )

    # ── poc_events ──
    op.create_table('poc_events',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False, index=True),
        sa.Column('delta', sa.Float(), nullable=False),
        sa.Column('poc_after', sa.Float(), nullable=False),
        sa.Column('reason', sa.String(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table('poc_events')
    op.drop_table('disputes')
    op.drop_table('play_events')
    op.drop_table('auth_requests')
    op.drop_table('transactions')
    op.drop_table('tl_files')
    op.drop_table('users')
