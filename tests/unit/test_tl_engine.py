import pytest
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from app.core.database import Base
from app.models.user import User
from app.models.tl_file import TLFile, AuthStatus
from app.services.tl_engine import (
    charge_file_tl, process_playback, lock_user_tl, unlock_user_tl, forfeit_account
)

TEST_DB = "sqlite+aiosqlite:///:memory:"
engine = create_async_engine(TEST_DB, connect_args={"check_same_thread": False})
Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(autouse=True)
async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.mark.asyncio
async def test_charge_file_tl():
    async with Session() as db:
        user = User(email="a@b.com", username="tester", password_hash="x", tl_balance=5000.0)
        db.add(user)
        tl_file = TLFile(user_id=1, title="Test Track", file_url="/tmp/test.mp3")
        db.add(tl_file)
        await db.flush()

        await charge_file_tl(db, user, tl_file, 1000.0)
        await db.commit()

        assert user.tl_balance == 4000.0
        assert tl_file.file_tl == 1000.0
        assert tl_file.max_file_tl == 1000.0


@pytest.mark.asyncio
async def test_charge_insufficient_balance():
    async with Session() as db:
        user = User(email="a@b.com", username="tester", password_hash="x", tl_balance=100.0)
        db.add(user)
        tl_file = TLFile(user_id=1, title="Test Track", file_url="/tmp/test.mp3")
        db.add(tl_file)
        await db.flush()

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            await charge_file_tl(db, user, tl_file, 500.0)
        assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_process_playback_verified():
    async with Session() as db:
        creator = User(email="creator@b.com", username="creator", password_hash="x", tl_balance=0.0)
        player = User(email="player@b.com", username="player", password_hash="x", tl_balance=0.0)
        db.add_all([creator, player])
        await db.flush()

        tl_file = TLFile(
            user_id=creator.id, title="Track", file_url="/tmp/test.mp3",
            file_tl=500.0, auth_status=AuthStatus.verified, shared=True
        )
        db.add(tl_file)
        await db.flush()

        event = await process_playback(db, tl_file, player.id, duration_seconds=30)
        await db.commit()

        assert event.tl_deducted == 30.0
        assert event.revenue_credited == pytest.approx(30.0 * 0.7)
        assert tl_file.file_tl == pytest.approx(470.0)
        assert creator.tl_balance == pytest.approx(21.0)


@pytest.mark.asyncio
async def test_car_mode_doubles_revenue():
    async with Session() as db:
        creator = User(email="c@b.com", username="creator2", password_hash="x", tl_balance=0.0)
        db.add(creator)
        await db.flush()

        tl_file = TLFile(
            user_id=creator.id, title="Track", file_url="/tmp/test.mp3",
            file_tl=500.0, auth_status=AuthStatus.verified, shared=True
        )
        db.add(tl_file)
        await db.flush()

        event = await process_playback(db, tl_file, None, duration_seconds=10, car_mode=True)
        await db.commit()

        # Car Mode: revenue_rate = min(1.0, 0.7 * 2.0) = 1.0
        assert event.revenue_credited == pytest.approx(10.0 * 1.0)


@pytest.mark.asyncio
async def test_lock_unlock_tl():
    async with Session() as db:
        user = User(email="u@b.com", username="user3", password_hash="x", tl_balance=1500.0)
        db.add(user)
        await db.flush()

        await lock_user_tl(db, user)
        assert user.tl_balance == 0.0
        assert user.tl_locked == 1500.0
        assert user.tl_suspended is True

        await unlock_user_tl(db, user)
        assert user.tl_balance == 1500.0
        assert user.tl_locked == 0.0
        assert user.tl_suspended is False


@pytest.mark.asyncio
async def test_forfeit_account():
    async with Session() as db:
        user = User(email="f@b.com", username="user4", password_hash="x",
                    tl_balance=2000.0, tlc_balance=5.0)
        db.add(user)
        await db.flush()

        await forfeit_account(db, user)
        assert user.tl_balance == 0.0
        assert user.tlc_balance == 0.0
        assert user.account_forfeited is True
