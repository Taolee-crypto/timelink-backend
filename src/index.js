# 백엔드의 src/index.js를 더 완전한 API로 업데이트
cat > /c/users/win11/timelink-backend/src/index.js << 'EOF'
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
   // CORS 헤더 설정 (GitHub Pages 도메인 허용)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',  // 모든 도메인 허용 (안전하지 않음)
  // 또는 특정 도메인만 허용:
  // 'Access-Control-Allow-Origin': 'https://taolee-crypto.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

    // OPTIONS 요청 처리 (CORS preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        headers: corsHeaders 
      });
    }

    // API 기본 정보
    if (path === '/api' || path === '/api/') {
      return Response.json({
        name: 'TimeLink API',
        version: '1.0.0',
        status: 'online',
        timestamp: new Date().toISOString(),
        endpoints: {
          auth: {
            login: '/api/auth/login (POST)',
            signup: '/api/auth/signup (POST)',
            verify: '/api/auth/verify (POST)'
          },
          music: {
            list: '/api/music/list (GET)',
            upload: '/api/music/upload (POST)',
            detail: '/api/music/:id (GET)',
            purchase: '/api/music/:id/purchase (POST)'
          },
          marketplace: {
            listings: '/api/marketplace/listings (GET)',
            create: '/api/marketplace/create (POST)',
            buy: '/api/marketplace/:id/buy (POST)'
          },
          dashboard: {
            stats: '/api/dashboard/stats (GET)',
            earnings: '/api/dashboard/earnings (GET)'
          },
          studio: {
            projects: '/api/studio/projects (GET)',
            create: '/api/studio/create (POST)'
          },
          payment: {
            balance: '/api/payment/balance (GET)',
            deposit: '/api/payment/deposit (POST)',
            withdraw: '/api/payment/withdraw (POST)'
          }
        }
      }, {
        headers: corsHeaders
      });
    }

    // 인증 API
    if (path === '/api/auth/login' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { email, password } = body;
        
        // 실제 인증 로직 (임시)
        const isValid = email && password;
        
        if (!isValid) {
          return Response.json({
            success: false,
            message: '이메일과 비밀번호를 확인해주세요.'
          }, {
            status: 401,
            headers: corsHeaders
          });
        }
        
        // JWT 토큰 생성 (임시)
        const tokenData = {
          userId: Date.now(),
          email: email,
          role: 'user',
          exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24시간
        };
        
        // Base64 인코딩 (실제로는 서명 필요)
        const token = btoa(JSON.stringify(tokenData));
        
        return Response.json({
          success: true,
          token: token,
          user: {
            id: tokenData.userId,
            email: email,
            name: email.split('@')[0],
            role: 'user'
          }
        }, {
          headers: corsHeaders
        });
      } catch (error) {
        return Response.json({
          success: false,
          message: '서버 오류가 발생했습니다.'
        }, {
          status: 500,
          headers: corsHeaders
        });
      }
    }

    if (path === '/api/auth/signup' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { email, password, name } = body;
        
        if (!email || !password) {
          return Response.json({
            success: false,
            message: '이메일과 비밀번호는 필수입니다.'
          }, {
            status: 400,
            headers: corsHeaders
          });
        }
        
        // 실제로는 DB 저장, 이메일 인증 등 필요
        return Response.json({
          success: true,
          message: '회원가입이 완료되었습니다. 이메일 인증을 완료해주세요.',
          userId: Date.now(),
          email: email
        }, {
          headers: corsHeaders
        });
      } catch (error) {
        return Response.json({
          success: false,
          message: '회원가입 처리 중 오류가 발생했습니다.'
        }, {
          status: 500,
          headers: corsHeaders
        });
      }
    }

    // 음원 목록 API
    if (path === '/api/music/list' && request.method === 'GET') {
      const musicList = [
        {
          id: 1,
          title: "Dreamy Sunrise",
          artist: "Luna Waves",
          price: 12.5,
          duration: "4:15",
          genre: "Ambient",
          bpm: 120,
          key: "C Major",
          mood: ["Relaxing", "Uplifting"],
          description: "아침 햇살을 담은 따뜻한 앰비언트 트랙",
          uploadDate: "2024-12-15",
          downloads: 234,
          rating: 4.7,
          previewUrl: "/audio/preview1.mp3",
          coverImage: "/images/cover1.jpg"
        },
        {
          id: 2,
          title: "Neon Streets",
          artist: "Cyber Pulse",
          price: 15.0,
          duration: "3:45",
          genre: "Synthwave",
          bpm: 128,
          key: "F# Minor",
          mood: ["Energetic", "Retro"],
          description: "1980년대 느낌의 사이버펑크 신스웨이브",
          uploadDate: "2024-12-14",
          downloads: 187,
          rating: 4.8,
          previewUrl: "/audio/preview2.mp3",
          coverImage: "/images/cover2.jpg"
        },
        {
          id: 3,
          title: "Forest Whisper",
          artist: "Nature's Symphony",
          price: 10.0,
          duration: "5:20",
          genre: "Nature Sounds",
          bpm: 60,
          key: "Natural",
          mood: ["Calm", "Meditative"],
          description: "숲속의 자연 소리와 잔잔한 멜로디",
          uploadDate: "2024-12-13",
          downloads: 312,
          rating: 4.9,
          previewUrl: "/audio/preview3.mp3",
          coverImage: "/images/cover3.jpg"
        },
        {
          id: 4,
          title: "Midnight Drive",
          artist: "City Lights",
          price: 13.5,
          duration: "4:00",
          genre: "Lo-Fi",
          bpm: 85,
          key: "G Minor",
          mood: ["Chill", "Nostalgic"],
          description: "밤 도로를 달리는 느낌의 로파이 힙합",
          uploadDate: "2024-12-12",
          downloads: 198,
          rating: 4.6,
          previewUrl: "/audio/preview4.mp3",
          coverImage: "/images/cover4.jpg"
        },
        {
          id: 5,
          title: "Ocean Breeze",
          artist: "Aqua Melodies",
          price: 11.0,
          duration: "3:55",
          genre: "Chillout",
          bpm: 100,
          key: "A Major",
          mood: ["Peaceful", "Refreshing"],
          description: "파도 소리와 함께하는 편안한 칼라웃 음악",
          uploadDate: "2024-12-11",
          downloads: 276,
          rating: 4.7,
          previewUrl: "/audio/preview5.mp3",
          coverImage: "/images/cover5.jpg"
        },
        {
          id: 6,
          title: "Digital Rain",
          artist: "Tech Beats",
          price: 14.5,
          duration: "4:30",
          genre: "Drum & Bass",
          bpm: 174,
          key: "D Minor",
          mood: ["Intense", "Futuristic"],
          description: "강렬한 드럼과 베이스 라인의 테크노 트랙",
          uploadDate: "2024-12-10",
          downloads: 154,
          rating: 4.5,
          previewUrl: "/audio/preview6.mp3",
          coverImage: "/images/cover6.jpg"
        }
      ];

      return Response.json({
        success: true,
        count: musicList.length,
        music: musicList,
        pagination: {
          page: 1,
          totalPages: 1,
          totalItems: musicList.length,
          itemsPerPage: 20
        }
      }, {
        headers: corsHeaders
      });
    }

    // 마켓플레이스 목록 API
    if (path === '/api/marketplace/listings' && request.method === 'GET') {
      const listings = [
        {
          id: 101,
          title: "Exclusive Beat Pack",
          seller: {
            id: 1,
            name: "ProducerX",
            rating: 4.9,
            verified: true
          },
          price: 49.99,
          genre: "Hip-Hop",
          type: "Beat Pack",
          items: 10,
          format: ["WAV", "MIDI", "STEMS"],
          license: "Premium",
          description: "10개의 독점 힙합 비트 포함, 상업적 사용 가능",
          tags: ["exclusive", "commercial", "premium"],
          uploadDate: "2024-12-15",
          sales: 42,
          rating: 4.8
        },
        {
          id: 102,
          title: "Cinematic Strings Collection",
          seller: {
            id: 2,
            name: "OrchestraMaster",
            rating: 4.7,
            verified: true
          },
          price: 79.99,
          genre: "Cinematic",
          type: "Sample Pack",
          items: 50,
          format: ["WAV", "SFZ"],
          license: "Royalty-Free",
          description: "영화 음악용 현악기 샘플 컬렉션",
          tags: ["cinematic", "orchestral", "royalty-free"],
          uploadDate: "2024-12-14",
          sales: 28,
          rating: 4.9
        },
        {
          id: 103,
          title: "Vocal Chops & Phrases",
          seller: {
            id: 3,
            name: "VocalLab",
            rating: 4.6,
            verified: false
          },
          price: 29.99,
          genre: "Pop",
          type: "Vocal Samples",
          items: 25,
          format: ["WAV", "MP3"],
          license: "Standard",
          description: "팝 음악용 보컬 샘플과 프레이즈",
          tags: ["vocals", "pop", "chops"],
          uploadDate: "2024-12-13",
          sales: 67,
          rating: 4.5
        }
      ];

      return Response.json({
        success: true,
        count: listings.length,
        listings: listings,
        filters: {
          genres: ["All", "Hip-Hop", "Cinematic", "Pop", "Electronic", "Jazz"],
          types: ["Beat Pack", "Sample Pack", "Vocal Samples", "Loop Pack"],
          licenses: ["All", "Royalty-Free", "Premium", "Standard"],
          priceRange: { min: 0, max: 1000 }
        }
      }, {
        headers: corsHeaders
      });
    }

    // 대시보드 API
    if (path === '/api/dashboard/stats' && request.method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return Response.json({
          success: false,
          message: '인증이 필요합니다.'
        }, {
          status: 401,
          headers: corsHeaders
        });
      }

      const stats = {
        overview: {
          totalEarnings: 1250.75,
          totalDownloads: 342,
          activeListings: 8,
          followers: 156,
          rating: 4.7
        },
        earnings: {
          today: 45.20,
          thisWeek: 320.50,
          thisMonth: 1250.75,
          lastMonth: 980.30,
          growth: 27.6
        },
        activity: {
          recentSales: [
            { id: 1001, title: "Dreamy Sunrise", buyer: "UserA", amount: 12.5, time: "2시간 전" },
            { id: 1002, title: "Neon Streets", buyer: "UserB", amount: 15.0, time: "5시간 전" },
            { id: 1003, title: "Forest Whisper", buyer: "UserC", amount: 10.0, time: "1일 전" }
          ],
          recentPurchases: [
            { id: 2001, title: "Cinematic Strings", seller: "OrchestraMaster", amount: 79.99, time: "3일 전" }
          ],
          recentActivities: [
            { type: "upload", title: "New Beat Uploaded", time: "6시간 전" },
            { type: "sale", title: "Beat Sold to UserD", time: "1일 전" },
            { type: "withdrawal", title: "Withdrawal Requested", time: "2일 전" }
          ]
        },
        charts: {
          earningsByMonth: {
            labels: ["10월", "11월", "12월"],
            data: [850.30, 980.30, 1250.75]
          },
          downloadsByGenre: {
            labels: ["Ambient", "Synthwave", "Lo-Fi", "Other"],
            data: [120, 87, 65, 70]
          }
        }
      };

      return Response.json({
        success: true,
        stats: stats,
        lastUpdated: new Date().toISOString()
      }, {
        headers: corsHeaders
      });
    }

    // 음원 업로드 API
    if (path === '/api/music/upload' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return Response.json({
          success: false,
          message: '인증이 필요합니다.'
        }, {
          status: 401,
          headers: corsHeaders
        });
      }

      try {
        // FormData 처리 (실제로는 파일 저장 필요)
        const contentType = request.headers.get('content-type');
        
        if (contentType.includes('multipart/form-data')) {
          // 파일 업로드 처리
          const formData = await request.formData();
          const file = formData.get('file');
          const title = formData.get('title');
          const description = formData.get('description');
          const price = formData.get('price');
          const genre = formData.get('genre');
          
          if (!file) {
            return Response.json({
              success: false,
              message: '파일이 필요합니다.'
            }, {
              status: 400,
              headers: corsHeaders
            });
          }

          // 실제로는 Cloudflare R2나 다른 스토리지에 파일 저장
          const uploadedFile = {
            id: Date.now(),
            filename: file.name,
            size: file.size,
            type: file.type,
            title: title || file.name.replace(/\.[^/.]+$/, ""),
            description: description || '',
            price: price ? parseFloat(price) : 0,
            genre: genre || 'Unknown',
            uploadDate: new Date().toISOString(),
            status: 'pending'
          };

          return Response.json({
            success: true,
            message: '음원 업로드가 시작되었습니다.',
            file: uploadedFile,
            processing: true,
            estimatedTime: '1-2분'
          }, {
            headers: corsHeaders
          });
        } else {
          // JSON 데이터 처리
          const body = await request.json();
          
          return Response.json({
            success: true,
            message: '업로드 정보가 저장되었습니다.',
            data: body
          }, {
            headers: corsHeaders
          });
        }
      } catch (error) {
        return Response.json({
          success: false,
          message: '업로드 처리 중 오류가 발생했습니다.',
          error: error.message
        }, {
          status: 500,
          headers: corsHeaders
        });
      }
    }

    // 결제 잔액 확인 API
    if (path === '/api/payment/balance' && request.method === 'GET') {
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return Response.json({
          success: false,
          message: '인증이 필요합니다.'
        }, {
          status: 401,
          headers: corsHeaders
        });
      }

      return Response.json({
        success: true,
        balance: {
          available: 1250.75,
          pending: 320.50,
          currency: 'TL',
          lastUpdated: new Date().toISOString()
        },
        wallets: [
          { type: 'primary', balance: 1250.75, currency: 'TL' },
          { type: 'earning', balance: 450.20, currency: 'TL' }
        ]
      }, {
        headers: corsHeaders
      });
    }

    // 404 처리
    return Response.json({
      success: false,
      message: '요청하신 API를 찾을 수 없습니다.',
      path: path,
      method: request.method
    }, {
      status: 404,
      headers: corsHeaders
    });
  }
}
EOF
