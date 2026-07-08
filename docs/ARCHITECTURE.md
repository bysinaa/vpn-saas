# 🏗️ Architecture Documentation

Complete architecture reference for the VPN SaaS Platform.

---

## Overview

The VPN SaaS Platform is a production-ready, scalable backend system built on **Clean Architecture** principles using **NestJS**. It powers multiple clients (Telegram Bot, Mini App, Web Dashboard, Mobile App, Public API) through a unified REST API.

### Design Principles

1. **Clean Architecture** — separation of concerns: controllers (transport) → services (business logic) → Prisma (data access)
2. **Dependency Injection** — all services are injectable; interfaces (STORAGE, PAYMENT_GATEWAYS, PANEL_CLIENTS) enable swappable implementations
3. **Repository Pattern** — PrismaService acts as a thin data access layer with transactional support
4. **Modular Design** — each feature is a self-contained NestJS module; modules communicate via DI and events
5. **Interface Segregation** — abstractions (IPaymentGateway, IPanelClient, IStorage) decouple business logic from external providers
6. **Statelessness** — app instances are stateless (sessions in Redis, files in S3); enables horizontal scaling

---

## System Architecture Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │                  Clients                     │
                    └──────┬───────┬───────┬───────┬──────────────┘
                           │       │       │       │
                     ┌─────┘  ┌────┘  ┌────┘  ┌────┘
                     │        │       │       │
                Telegram    Mini App  Web    Mobile   Public API
                  Bot      (WebApp)  Dashboard  App   (API Keys)
                     │        │       │       │       │
                     └────────┴───────┴───────┴───────┘
                                  │
                           ┌──────┴──────┐
                           │    NGINX    │ (reverse proxy, TLS, rate limit)
                           └──────┬──────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │      NestJS Application     │
                    │     (Horizontally Scalable)  │
                    │                              │
                    │  ┌──────────────────────┐   │
                    │  │   Global Guards       │   │
                    │  │  (JWT + RBAC + API Key)│   │
                    │  └──────────┬───────────┘   │
                    │             │                │
                    │  ┌──────────┴───────────┐   │
                    │  │   Feature Modules     │   │
                    │  │  (20+ NestJS modules) │   │
                    │  └──────────┬───────────┘   │
                    │             │                │
                    │  ┌──────────┴───────────┐   │
                    │  │  BullMQ Queue Workers │   │
                    │  │  (background jobs)    │   │
                    │  └──────────┬───────────┘   │
                    └─────────────┼───────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
        ┌─────┴─────┐      ┌──────┴──────┐    ┌───────┴───────┐
        │ PostgreSQL │      │    Redis     │    │  S3 / MinIO   │
        │  (primary) │      │ (cache+queue)│    │  (file storage)│
        └───────────┘      └─────────────┘    └───────────────┘
                                  │
                           ┌──────┴──────┐
                           │ VPN Panel    │
                           │ (Sanity/3X-UI)│
                           └─────────────┘
```

---

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Node.js 20 LTS | JavaScript runtime |
| **Framework** | NestJS 10 | Modular backend framework |
| **Language** | TypeScript 5.4 | Type-safe development |
| **ORM** | Prisma 5 | Database access & migrations |
| **Database** | PostgreSQL 16 | Primary data store |
| **Cache/Queue** | Redis 7 + BullMQ | Caching & background jobs |
| **Storage** | S3 / MinIO | File uploads (receipts, avatars) |
| **Auth** | JWT (access + refresh) | Stateless authentication |
| **Validation** | Zod | Schema validation |
| **Logging** | Pino | Structured JSON logging |
| **Bot Framework** | Telegraf | Telegram bot |
| **API Docs** | Swagger/OpenAPI | Auto-generated documentation |
| **Containerization** | Docker | Consistent deployments |
| **Reverse Proxy** | NGINX | TLS termination, rate limiting |
| **CI/CD** | GitHub Actions | Automated testing & deployment |

---

## Module Architecture

Each module follows the same internal structure:

```
src/modules/<feature>/
├── <feature>.module.ts        # NestJS module definition
├── <feature>.controller.ts    # HTTP route handlers (transport layer)
├── <feature>.service.ts       # Business logic (domain layer)
├── <feature>.schemas.ts       # Zod validation schemas
├── <feature>.types.ts          # TypeScript interfaces/types (optional)
└── *.interface.ts              # Abstraction interfaces (optional)
```

### Module Dependency Graph

```
                    ┌──────────┐
                    │   Auth   │ (Global guards: JWT + RBAC)
                    └────┬─────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
    ┌─────┴─────┐  ┌─────┴─────┐  ┌────┴─────┐
    │   Users   │  │  Wallet   │  │  Plans   │
    └───────────┘  └───────────┘  └──────────┘
                         │              │
                    ┌────┴─────┐  ┌────┴─────┐
                    │  Orders  │←─┤Subscriptions│
                    └────┬─────┘  └────┬──────┘
                         │             │
                    ┌────┴─────┐  ┌────┴─────┐
                    │ Payments │  │   VPN    │ (forwardRef)
                    └──────────┘  └──────────┘
                                        │
                                  ┌─────┴─────┐
                                  │  Panels   │
                                  └───────────┘

    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │  Telegram    │  │   MiniApp    │  │     API      │
    │  (imports:   │  │  (imports:   │  │  (API keys)  │
    │  Auth,Wallet, │  │  Auth,Wallet,│  │              │
    │  Plans,Orders,│  │  Plans,Subs, │  │              │
    │  Subscriptions)│ │  Orders)     │  │              │
    └──────────────┘  └──────────────┘  └──────────────┘

    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ Notifications│  │  Analytics   │  │   Reports    │
    └──────────────┘  └──────────────┘  └──────────────┘

    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │    Admin     │  │  Affiliate   │  │   Tickets    │
    └──────────────┘  └──────────────┘  └──────────────┘

    ┌──────────────┐  ┌──────────────┐
    │  Education   │  │   Settings   │
    └──────────────┘  └──────────────┘
```

---

## Cross-Cutting Concerns

### Authentication & Authorization

- **JWT Access Tokens** — short-lived (15 min), validated on every request
- **JWT Refresh Tokens** — long-lived (7 days), stored in DB with reuse detection
- **RBAC** — roles (SUPER_ADMIN, ADMIN, OPERATOR, SUPPORT, USER) + granular permissions with wildcard support
- **API Keys** — alternative auth for programmatic clients (X-API-Key header)
- **Global Guards** — JwtAuthGuard + AuthorizationGuard registered as APP_GUARD

### Validation

- **Zod Schemas** — every endpoint validates input via `ZodValidationPipe`
- **Global ValidationPipe** — NestJS class-validator for DTO transform/whitelist
- **Environment Validation** — Zod validates all env vars at boot

### Error Handling

- **BusinessException** — domain errors with stable error codes
- **AllExceptionsFilter** — global filter producing unified JSON envelope:
  ```json
  { "success": false, "error": { "code": "NOT_FOUND", "message": "...", "details": {} }, "timestamp": "...", "path": "..." }
  ```

### Logging

- **Pino** — structured JSON logs in production, pretty-printed in dev
- **Request logging** — every HTTP request logged with duration, status, user agent
- **Contextual logging** — module names as logger context

### Caching

- **Cache-Aside Pattern** — `RedisService.cached<T>(key, ttl, loader)` helper
- **Invalidation** — explicit cache invalidation on writes
- **TTL-based** — all cached data has a TTL (default 300s)

### Background Jobs

BullMQ queues handle async work:

| Queue | Purpose |
|-------|---------|
| `payments` | Receipt verification, payment settlement |
| `panel-sync` | VPN panel user sync, health checks |
| `notifications` | Telegram message delivery |
| `broadcast` | Mass notification fan-out |
| `subscriptions` | Subscription expiry, low-traffic alerts |
| `vpn-users` | VPN user lifecycle management |
| `crypto-verify` | Crypto payment confirmation polling |
| `referral-rewards` | Referral commission processing |
| `analytics` | Daily metrics snapshots |
| `email` | Email notification delivery |

---

## Data Model Overview

### Core Entities

```
User ──┬── Wallet (1:1)
       ├── Subscriptions (1:N) ── Plan (N:1)
       ├── Orders (1:N) ── OrderItems
       ├── Payments (1:N)
       ├── Notifications (1:N)
       ├── Tickets (1:N) ── TicketMessages
       ├── AffiliateAccount (1:1) ── Commissions (1:N)
       ├── ReferralLogs (1:N)
       ├── ApiKeys (1:N)
       └── EducationProgress (1:N)

Plan ──┬── PlanCategory (N:1)
       └── Subscriptions (1:N)

VpnPanel ──┬── VpnUsers (1:N) ── Subscriptions (1:1)
           └── ServerHealthLogs (1:N)

Country ── City ── Server ── Inbounds

Payment ──┬── PaymentReceipt (card-to-card)
          ├── CryptoPayment
          └── Voucher (redeemable)

Broadcast ── BroadcastTargets (1:N)

SystemSetting ── (key-value config)
FeatureFlag ── (toggleable features)
AnalyticsSnapshot ── (daily metrics)
JobLog ── (job execution audit trail)
```

### Money Handling

All monetary values are stored as **BigInt minor units** (e.g., cents, rials):
- `price: MinorUnits` (custom BigInt scalar)
- Prevents floating-point precision errors
- `MoneyUtil` handles formatting for display

### Soft Deletes

- `deletedAt: DateTime?` on all major entities
- Queries exclude soft-deleted records by default
- Admin can view deleted records with special filters

### Audit Trail

- `createdAt`, `updatedAt` on all entities
- `AuditService` logs sensitive operations (auth events, wallet mutations)
- `JobLog` records all background job executions

---

## Security Architecture

### Data at Rest

- **Panel API Keys** — AES-256-GCM encrypted via `CryptoUtil.encrypt()` (key derived from `ENCRYPTION_KEY` via scrypt)
- **Passwords** — bcrypt hashed via `PasswordService`
- **API Keys** — SHA-256 hashed (never stored plaintext)

### Data in Transit

- **HTTPS** — TLS 1.2+ via NGINX
- **JWT** — signed with HMAC-SHA256
- **Telegram Webhook** — validated via secret token

### Secrets Management

- **Environment variables** — validated at boot via Zod
- **No secrets in code** — all secrets come from env/config
- **`.env` excluded** — never committed to Git

### Rate Limiting

- **NGINX** — IP-based rate limiting (20 req/s general, 5 req/s auth)
- **Application-level** — configurable via `RATE_LIMIT_*` env vars

---

## Scalability Strategy

### Horizontal Scaling

1. **Stateless app instances** — no in-memory sessions; Redis-backed
2. **Redis-backed bot sessions** — Telegram bot works across multiple instances
3. **Queue-based processing** — BullMQ distributes jobs across workers
4. **Database connection pooling** — PgBouncer for high connection counts

### Performance Optimization

1. **Redis caching** — plans, settings, feature flags, user permissions cached
2. **Database indexing** — all query fields indexed in Prisma schema
3. **Pagination** — all list endpoints use cursor/offset pagination
4. **Background processing** — heavy work offloaded to queues
5. **Bulk operations** — broadcast delivery chunked to avoid rate limits

---

## Extension Points

The platform is designed for extensibility via interface abstractions:

| Interface | Symbol Token | Purpose |
|-----------|-------------|---------|
| `IStorage` | `STORAGE` | S3, local, GCS, Azure Blob |
| `IPaymentGateway` | `PAYMENT_GATEWAYS` | Zarinpal, Stripe, PayPal |
| `IPanelClient` | `PANEL_CLIENTS` | Sanity, 3X-UI, Marzban |

To add a new payment gateway:

1. Implement `IPaymentGateway` interface
2. Register in `PAYMENT_GATEWAYS` provider factory
3. Add gateway code to `config.payments`
4. No changes to `PaymentsService` needed (Open/Closed Principle)

---

## Future Architecture Considerations

- **Event Sourcing** — for audit-critical domains (wallet, payments)
- **CQRS** — separate read models for analytics dashboards
- **GraphQL** — for flexible client queries (Mini App, Mobile)
- **WebSocket** — real-time notifications for admin dashboard
- **Multi-tenancy** — for white-label deployments
- **Microservices** — split into services at scale (payments, VPN, bot)
