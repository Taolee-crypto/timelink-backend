from fastapi import APIRouter, HTTPException, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
from typing import List, Optional
from app.core.database import get_db
from app.api.v1.endpoints.users import get_current_user
from app.models.user import User
from app.models.timeline import TimelinePost, Like, Comment
from app.schemas.timeline import (
    TimelinePostCreate, TimelinePostUpdate, TimelinePostResponse,
    SunoConvertRequest, CommentCreate, CommentResponse
)

router = APIRouter()

@router.get("/posts", response_model=List[TimelinePostResponse])
async def get_timeline_posts(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    current_user: Optional[User] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    타임라인 포스트 목록 조회 (페이지네이션)
    """
    offset = (page - 1) * limit
    
    # 포스트 조회
    result = await db.execute(
        select(TimelinePost)
        .order_by(desc(TimelinePost.created_at))
        .offset(offset)
        .limit(limit)
    )
    posts = result.scalars().all()
    
    # 좋아요 상태 확인
    if current_user:
        for post in posts:
            like_result = await db.execute(
                select(Like).where(
                    Like.post_id == post.id,
                    Like.user_id == current_user.id
                )
            )
            post.is_liked = like_result.scalar_one_or_none() is not None
    
    return posts

@router.post("/posts", response_model=TimelinePostResponse)
async def create_post(
    request: TimelinePostCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    새 포스트 작성
    """
    post = TimelinePost(
        user_id=current_user.id,
        content=request.content,
        media_url=request.media_url,
        initial_tl_balance=1000  # 기본 TL 지급
    )
    
    db.add(post)
    await db.commit()
    await db.refresh(post)
    
    return post

@router.post("/posts/suno-convert", response_model=TimelinePostResponse)
async def convert_suno_post(
    request: SunoConvertRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Suno AI 음원을 TL3 포스트로 변환
    """
    # TODO: 실제 Suno API 호출하여 구독 확인
    # - get_credits()로 Pro/Premier 확인
    # - get_song()으로 메타데이터 가져오기
    
    post = TimelinePost(
        user_id=current_user.id,
        content=f"🎵 {request.title} - {request.artist}",
        is_suno_convert=True,
        suno_original_url=request.suno_url,
        tl_per_second=1,
        initial_tl_balance=1000,  # 초기 TL 지급
        plays_count=0
    )
    
    db.add(post)
    await db.commit()
    await db.refresh(post)
    
    return post

@router.get("/posts/{post_id}", response_model=TimelinePostResponse)
async def get_post(
    post_id: int,
    current_user: Optional[User] = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    특정 포스트 조회
    """
    result = await db.execute(
        select(TimelinePost).where(TimelinePost.id == post_id)
    )
    post = result.scalar_one_or_none()
    
    if not post:
        raise HTTPException(status_code=404, detail="포스트를 찾을 수 없습니다")
    
    # 좋아요 상태 확인
    if current_user:
        like_result = await db.execute(
            select(Like).where(
                Like.post_id == post.id,
                Like.user_id == current_user.id
            )
        )
        post.is_liked = like_result.scalar_one_or_none() is not None
    
    return post

@router.patch("/posts/{post_id}", response_model=TimelinePostResponse)
async def update_post(
    post_id: int,
    request: TimelinePostUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    포스트 수정
    """
    result = await db.execute(
        select(TimelinePost).where(TimelinePost.id == post_id)
    )
    post = result.scalar_one_or_none()
    
    if not post:
        raise HTTPException(status_code=404, detail="포스트를 찾을 수 없습니다")
    
    if post.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="수정 권한이 없습니다")
    
    if request.content is not None:
        post.content = request.content
    if request.media_url is not None:
        post.media_url = request.media_url
    
    await db.commit()
    await db.refresh(post)
    
    return post

@router.delete("/posts/{post_id}")
async def delete_post(
    post_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    포스트 삭제
    """
    result = await db.execute(
        select(TimelinePost).where(TimelinePost.id == post_id)
    )
    post = result.scalar_one_or_none()
    
    if not post:
        raise HTTPException(status_code=404, detail="포스트를 찾을 수 없습니다")
    
    if post.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="삭제 권한이 없습니다")
    
    await db.delete(post)
    await db.commit()
    
    return {"message": f"Post {post_id} deleted successfully"}

@router.post("/posts/{post_id}/like")
async def like_post(
    post_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    포스트 좋아요
    """
    # 이미 좋아요 했는지 확인
    result = await db.execute(
        select(Like).where(
            Like.post_id == post_id,
            Like.user_id == current_user.id
        )
    )
    existing_like = result.scalar_one_or_none()
    
    if existing_like:
        raise HTTPException(status_code=400, detail="이미 좋아요한 포스트입니다")
    
    # 좋아요 생성
    like = Like(
        user_id=current_user.id,
        post_id=post_id
    )
    
    db.add(like)
    
    # 포스트 좋아요 수 증가
    await db.execute(
        TimelinePost.__table__.update()
        .where(TimelinePost.id == post_id)
        .values(likes_count=TimelinePost.likes_count + 1)
    )
    
    await db.commit()
    
    return {"message": "Post liked successfully"}

@router.delete("/posts/{post_id}/like")
async def unlike_post(
    post_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    포스트 좋아요 취소
    """
    result = await db.execute(
        select(Like).where(
            Like.post_id == post_id,
            Like.user_id == current_user.id
        )
    )
    like = result.scalar_one_or_none()
    
    if not like:
        raise HTTPException(status_code=400, detail="좋아요하지 않은 포스트입니다")
    
    await db.delete(like)
    
    # 포스트 좋아요 수 감소
    await db.execute(
        TimelinePost.__table__.update()
        .where(TimelinePost.id == post_id)
        .values(likes_count=TimelinePost.likes_count - 1)
    )
    
    await db.commit()
    
    return {"message": "Post unliked successfully"}

# 댓글 API
@router.get("/posts/{post_id}/comments", response_model=List[CommentResponse])
async get_post_comments(
    post_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    포스트의 댓글 목록 조회
    """
    result = await db.execute(
        select(Comment)
        .where(Comment.post_id == post_id)
        .order_by(Comment.created_at)
    )
    return result.scalars().all()

@router.post("/posts/{post_id}/comments", response_model=CommentResponse)
async create_comment(
    post_id: int,
    request: CommentCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    댓글 작성
    """
    comment = Comment(
        user_id=current_user.id,
        post_id=post_id,
        content=request.content
    )
    
    db.add(comment)
    
    # 포스트 댓글 수 증가
    await db.execute(
        TimelinePost.__table__.update()
        .where(TimelinePost.id == post_id)
        .values(comments_count=TimelinePost.comments_count + 1)
    )
    
    await db.commit()
    await db.refresh(comment)
    
    return comment
