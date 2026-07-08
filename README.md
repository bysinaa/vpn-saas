# 🛡️ VPN SaaS Platform

A production-ready, scalable Telegram VPN selling platform built as a complete SaaS backend. Powers multiple clients: **Telegram Bot**, **Mini App**, **Web Dashboard**, **Mobile App**, and **Public API**.

![Status](https://img.shields.io/badge/status-production--ready-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-20%2B-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)

---

## ✨ Features

- **20+ Feature Modules** — Auth, Users, Wallet, Orders, VPN, Subscriptions, Payments, Servers, Panels, Telegram, Notifications, Admin, Affiliate, Tickets, Education, Analytics, Reports, Settings, API, Mini App
- **Multiple Payment Methods** — Online gateway (Zarinpal), Card-to-Card, Crypto, Wallet, Vouchers
- **Telegram Bot + Mini App** — Full inline keyboard flow + Web App backend
- **VPN Panel Integration** — Pluggable interface for Sanity/3X-UI/Marzban panels
- **Affiliate & Referral System** — Commission tracking, automated payouts
- **RBAC** — Roles (SUPER_ADMIN, ADMIN, OPERATOR, SUPPORT) with granular permissions
- **Background Jobs** — BullMQ queues for async processing
- **Analytics & Reports** — Daily metric snapshots, exportable CSV reports
- **Feature Flags** — Gradual rollout support
- **Docker Ready** — Multi-stage build, NGINX, Docker Compose

---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 LTS |
| Framework | NestJS 10 |
| Language | TypeScript 5.4 |
| Database | PostgreSQL 16 + Prisma 5 |
| Cache/Queue | Redis 7 + BullMQ |
| Storage | S3 / MinIO |
| Auth | JWT (access + refresh rotation) |
| Validation | Zod |
| Logging | Pino (structured JSON) |
| Bot | Telegraf |
| Docs | Swagger/OpenAPI |
| Deployment | Docker + NGINX |

---

## 📦 Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Redis 7+
- Docker & Docker Compose (recommended)

### Using Docker Compose (recommended)

```bash
# 1. Clone & configure
git clone <repository-url>
cd vpn-saas
cp .env.example .env
# Edit .env with your values

# 2. Build & start all services
docker-compose up -d --build

# 3. Run database migrations
docker-compose exec app npx prisma migrate deploy

# 4. Verify
curl http://localhost/health
```

### Local Development

```bash
# 1. Install dependencies
npm install

# 2. Generate Prisma client
npx prisma generate

# 3. Set up database
npx prisma migrate dev

# 4. Start in watch mode
npm run start:dev
```

> Swagger UI available at `http://localhost:3000/api/v1/docs` (development only)

---

## 📁 Project Structure

```
vpn-saas/
├── src/
│   ├── common/                    # Cross-cutting infrastructure
│   │   ├── audit/                 # Audit logging
│   │   ├── exceptions/            # Domain exceptions
│   │   ├── filters/               # Global exception filter
│   │   ├── health/                # Health checks
│   │   ├── logger/                # Pino logging
│   │   ├── pagination/            # Pagination utilities
│   │   ├── pipes/                 # Zod validation pipe
│   │   ├── prisma/                # Prisma service
│   │   ├── queue/                 # BullMQ queue config
│   │   ├── redis/                # Redis service
│   │   ├── storage/               # S3 storage abstraction
│   │   └── utils/                 # Crypto, money utilities
│   ├── config/                    # Environment config
│   ├── modules/                   # Feature modules
│   │   ├── admin/
│   │   ├── affiliate/
│   │   ├── analytics/
│   │   ├── api/                   # API key management
│   │   ├── auth/                  # JWT, RBAC, guards
│   │   ├── education/
│   │   ├── miniapp/               # Telegram Mini App
│   │   ├── notifications/
│   │   ├── orders/
│   │   ├── panels/                # VPN panel integration
│   │   ├── payments/              # Payment gateways
│   │   ├── plans/
│   │   ├── reports/
│   │   ├── servers/
│   │   ├── settings/              # System settings + feature flags
│   │   ├── subscriptions/
│   │   ├── telegram/              # Bot + i18n + keyboards
│   │   ├── tickets/
│   │   ├── users/
│   │   ├── vpn/
│   │   └── wallet/
│   ├── app.module.ts              # Root module
│   └── main.ts                    # Entry point
├── prisma/
│   └── schema.prisma              # Database schema
├── nginx/                         # NGINX configuration
├── docs/                          # Documentation
├── .github/workflows/             # CI/CD pipeline
├── Dockerfile                     # Multi-stage build
├── docker-compose.yml             # Production compose
└── docker-compose.dev.yml         # Development overrides
```

---

## 🔑 Key Abstractions

The platform uses dependency injection with symbol tokens for swappable providers:

| Interface | Symbol | Implementations |
|-----------|--------|-----------------|
| `IStorage` | `STORAGE` | S3StorageService (default), extend for GCS/Azure |
| `IPaymentGateway` | `PAYMENT_GATEWAYS` | ZarinpalGateway (default), extend for Stripe/PayPal |
| `IPanelClient` | `PANEL_CLIENTS` | SanityPanelClient (default), extend for Marzban/3X-UI |

**Adding a new payment gateway requires zero changes to existing code** (Open/Closed Principle).

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/ARCHITECTURE.md) | System design, module graph, data model |
| [API Reference](docs/API.md) | All endpoints with examples |
| [Deployment Guide](docs/DEPLOYMENT.md) | Docker, manual deploy, CI/CD |
| [Security Checklist](docs/SECURITY.md) | Hardening guide |
| [Testing Strategy](docs/TESTING.md) | Unit, integration, E2E |

---

## 🔧 Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full list.

### Critical Variables

```env
NODE_ENV=production
APP_URL=https://your-domain.com
DATABASE_URL=postgresql://user:pass@localhost:5432/vpn_saas
REDIS_HOST=localhost
JWT_ACCESS_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -hex 32>
TELEGRAM_BOT_TOKEN=<from @BotFather>
```

---

## 🧪 Testing

```bash
# Unit tests
npm test

# With coverage
npm test -- --coverage

# Integration tests (requires Docker)
docker-compose -f docker-compose.test.yml up -d
npm run test:e2e
```

See [Testing Strategy](docs/TESTING.md) for details.

---

## 🚀 Deployment

### Docker Compose (production)

```bash
docker-compose up -d --build
```

### CI/CD

Push to `main` triggers the [GitHub Actions pipeline](.github/workflows/ci-cd.yml):
1. Lint + type check
2. Unit tests + coverage
3. Docker image build
4. Integration tests (real PostgreSQL + Redis)
5. Push to GHCR (on main/tags)

See [Deployment Guide](docs/DEPLOYMENT.md) for full instructions.

---

## 📊 Architecture Highlights

- **Clean Architecture** — controllers (transport) → services (logic) → Prisma (data)
- **Stateless** — Redis-backed sessions enable horizontal scaling
- **Encrypted at Rest** — Panel API keys use AES-256-GCM
- **Transactional** — wallet mutations and payouts are atomic
- **Cached** — plans, settings, permissions cached in Redis
- **Background Processing** — 10 BullMQ queues for async work

---

## 🔒 Security

- JWT with refresh token rotation + reuse detection
- RBAC with wildcard permission support
- Timing-safe comparisons for webhook validation
- AES-256-GCM encryption for sensitive data
- Rate limiting at NGINX + application level
- Security headers (HSTS, X-Frame-Options, etc.)

See [Security Checklist](docs/SECURITY.md) for the full hardening guide.

---

## 📄 License

MIT — see [LICENSE](LICENSE) file.
