"""initial migration

Revision ID: 001
Revises: 
Create Date: 2024-01-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa

revision = '001'
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:
    # users 테이블
    op.create_table(
        'users',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('email', sa.String(), nullable=False),
        sa.Column('username', sa.String(), nullable=False),
        sa.Column('hashed_password', sa.String(), nullable=False),
        sa.Column('bio', sa.String(), nullable=True),
        sa.Column('profile_image', sa.String(), nullable=True),
        sa.Column('tl_balance', sa.Integer(), nullable=False, server_default='10000'),
        sa.Column('tl_locked', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('trust_score', sa.Float(), nullable=False, server_default='1.0'),
        sa.Column('lvs_score', sa.Float(), nullable=False, server_default='1.0'),
        sa.Column('total_listened', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('car_mode_enabled', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('auto_recharge_enabled', sa.Boolean(), nullable=False, server_default='1'),
        sa.Column('auto_recharge_threshold', sa.Integer(), nullable=False, server_default='2000'),
        sa.Column('auto_recharge_amount', sa.Integer(), nullable=False, server_default='5000'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.text('CURRENT_TIMESTAMP')),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_users_email'), 'users', ['email'], unique=True)
    op.create_index(op.f('ix_users_id'), 'users', ['id'], unique=False)
    op.create_index(op.f('ix_users_username'), 'users', ['username'], unique=True)

    # timeline_posts 테이블
    op.create_table(
        'timeline_posts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('media_url', sa.String(), nullable=True),
        sa.Column('is_suno_convert', sa.Boolean(), nullable=False, server_default='0'),
        sa.Column('suno_original_url', sa.String(), nullable=True),
        sa.Column('suno_song_id', sa.String(), nullable=True),
        sa.Column('tl_per_second', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('initial_tl_balance', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('likes_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('comments_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('plays_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.text('CURRENT_TIMESTAMP')),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_timeline_posts_id'), 'timeline_posts', ['id'], unique=False)

    # likes 테이블
    op.create_table(
        'likes',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('post_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.ForeignKeyConstraint(['post_id'], ['timeline_posts.id'], ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_likes_id'), 'likes', ['id'], unique=False)

    # comments 테이블
    op.create_table(
        'comments',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('post_id', sa.Integer(), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('CURRENT_TIMESTAMP')),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.text('CURRENT_TIMESTAMP')),
        sa.ForeignKeyConstraint(['post_id'], ['timeline_posts.id'], ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_comments_id'), 'comments', ['id'], unique=False)

def downgrade() -> None:
    op.drop_table('comments')
    op.drop_table('likes')
    op.drop_table('timeline_posts')
    op.drop_table('users')
