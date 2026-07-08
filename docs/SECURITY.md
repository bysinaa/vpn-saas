# 🔒 Security Checklist & Hardening Guide

Security documentation and hardening checklist for the VPN SaaS Platform.

---

## Table of Contents

1. [Authentication Security](#authentication-security)
2. [Authorization & RBAC](#authorization--rbac)
3. [Data Protection](#data-protection)
4. [Transport Security](#transport-security)
5. [Input Validation](#input-validation)
6. [Rate Limiting & DDoS Protection](#rate-limiting--ddos-protection)
7. [Secrets Management](#secrets-management)
8. [Infrastructure Security](#infrastructure-security)
9. [Audit & Monitoring](#audit--monitoring)
10. [Pre-Deployment Checklist](#pre-deployment-checklist)

---

## Authentication Security

### JWT Implementation

- [x] Access tokens are short-lived (15 minutes default)
- [x] Refresh tokens are long-lived but stored in DB (revocable)
- [x] Refresh token rotation on every refresh call
- [x] Refresh token reuse detection (reusing an old token revokes the entire family)
- [x] Tokens signed with HMAC-SHA256 using separate secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`)
- [x] Token claims include `iss` (issuer) and `aud` (audience) for validation
- [x] `exp` (expiry) enforced on both access and refresh tokens

### Password Security

- [x] Passwords hashed with bcrypt (configurable cost factor, default 12)
- [x] Minimum password length enforced (8 characters)
- [x] Passwords never returned in API responses
- [x] Password reset via secure token (time-limited, single-use)

### Session Management

- [x] Sessions stored in PostgreSQL (not JWT-only) for revocation capability
- [x] `userAgent` and `ip` recorded per session
- [x] Logout revokes the session and invalidates tokens
- [x] Concurrent session limit configurable

### Telegram Webhook Security

- [x] Webhook secret token validated via timing-safe comparison (`safeEqual`)
- [x] Secret token compared in constant time to prevent timing attacks
- [x] Bot endpoint marked `@Public` but requires valid secret token header

### Mini App Auth

- [x] Telegram WebApp `initData` validated via HMAC-SHA256
- [x] `auth_date` freshness check (max 24 hours)
- [x] Bot token used as HMAC key (never exposed to client)

---

## Authorization & RBAC

### Role-Based Access Control

| Role | Description | Key Permissions |
|------|-------------|-----------------|
| `SUPER_ADMIN` | Full system access | `*` (wildcard) |
| `ADMIN` | System management | `manage:*`, `read:*` |
| `OPERATOR` | Operational tasks | `manage:panels`, `manage:servers`, `reply:tickets` |
| `SUPPORT` | Customer support | `read:*`, `reply:tickets` |
| `USER` | Regular user | Self-service only |

### Permission Enforcement

- [x] Global `AuthorizationGuard` checks permissions on every request
- [x] `@RequirePermissions(['perm'])` decorator on admin endpoints
- [x] Wildcard permission support (`manage:*` matches `manage:panels`)
- [x] User-scoped queries (users can only access their own data)
- [x] Admin endpoints require explicit permissions, not just role check

### Permission Caching

- [x] Permissions cached in Redis (5 min TTL)
- [x] Cache invalidated on role/permission changes
- [x] Falls back to DB on cache miss

---

## Data Protection

### Encryption at Rest

- [x] **Panel API Keys** — AES-256-GCM encrypted via `CryptoUtil.encrypt()`
  - Key derived from `ENCRYPTION_KEY` using `scryptSync` (N=16384, r=8, p=1)
  - IV is random per encryption, prepended to ciphertext
  - Auth tag appended for integrity verification
- [x] **Passwords** — bcrypt hashed (never reversible)
- [x] **API Keys** — SHA-256 hashed (plaintext returned only once at creation)
- [x] **Refresh Tokens** — hashed before DB storage

### Sensitive Data Handling

- [x] No sensitive data in URL parameters (always in body/headers)
- [x] No sensitive data in logs (Pino serializers strip auth headers)
- [x] No secrets in error messages (generic messages for clients)
- [x] Database queries use parameterized inputs (Prisma prevents SQL injection)
- [x] File uploads validated by MIME type and size

### Data Minimization

- [x] API responses include only necessary fields (DTOs)
- [x] `ValidationPipe` with `whitelist: true` strips unknown fields
- [x] Admin list endpoints don't expose sensitive fields (passwords, tokens)

---

## Transport Security

### HTTPS/TLS

- [x] NGINX terminates TLS (TLS 1.2+ only)
- [x] Strong cipher suite enforced (`ssl_ciphers HIGH:!aNULL:!MD5`)
- [x] HSTS header (`Strict-Transport-Security: max-age=31536000; includeSubDomains`)
- [x] HTTP automatically redirects to HTTPS
- [x] SSL session caching for performance

### Security Headers

- [x] `X-Frame-Options: SAMEORIGIN` (clickjacking prevention)
- [x] `X-Content-Type-Options: nosniff` (MIME sniffing prevention)
- [x] `X-XSS-Protection: 1; mode=block`
- [x] `Referrer-Policy: strict-origin-when-cross-origin`

### CORS

- [x] Configurable allowed origins (`CORS_ORIGINS` env var)
- [x] Credentials only sent to allowed origins
- [x] Methods restricted to needed verbs
- [x] Preflight cache (`maxAge: 86400`)

---

## Input Validation

### Schema Validation

- [x] All endpoints validated via Zod schemas (`ZodValidationPipe`)
- [x] String length limits enforced (prevents buffer overflow attempts)
- [x] Numeric ranges validated (e.g., `rolloutPercent: 0-100`)
- [x] Enum values validated (prevents unexpected values)
- [x] Date formats validated (ISO 8601)

### SQL Injection Prevention

- [x] Prisma ORM uses parameterized queries by default
- [x] `$queryRaw` used only with tagged template literals (parameterized)
- [x] No string concatenation for SQL queries

### XSS Prevention

- [x] Input sanitized by Zod (length limits, type coercion)
- [x] Output encoded by NestJS serialization
- [x] Content-Security-Policy recommended for Mini App frontend

### File Upload Security

- [x] File type validation (MIME type checking)
- [x] File size limits (`client_max_body_size 50m` in NGINX)
- [x] Files stored in S3 with private ACL (signed URLs for access)
- [x] No executable file types allowed

---

## Rate Limiting & DDoS Protection

### NGINX Rate Limiting

- [x] General API: 20 req/s per IP (burst: 40)
- [x] Auth endpoints: 5 req/s per IP (burst: 10)
- [x] Telegram webhook: 100 req/s burst (Telegram's retry handles backpressure)
- [x] Health check: no rate limit (for load balancer probes)

### Application-Level Protection

- [x] Configurable rate limit via `RATE_LIMIT_TTL` / `RATE_LIMIT_LIMIT`
- [x] Wallet mutation operations are transactional (prevents race conditions)
- [x] Idempotency keys on payment endpoints (prevents double-charging)

### DDoS Mitigation

- [x] Cloudflare or equivalent recommended for L3/L4 DDoS protection
- [x] Connection limits in NGINX (`worker_connections`, `keepalive_timeout`)
- [x] Request body size limits (`client_max_body_size 50m`)

---

## Secrets Management

### Environment Variables

- [x] All secrets loaded from environment variables (never in code)
- [x] Environment validated at boot via Zod (missing secrets = crash)
- [x] `.env` file in `.gitignore` and `.dockerignore`
- [x] `.env.example` provided as template (no real secrets)

### Secret Generation

Generate strong secrets:

```bash
# JWT secrets (64 hex chars = 256 bits)
openssl rand -hex 32

# Encryption key for panel API keys
openssl rand -hex 32

# Telegram webhook secret
openssl rand -hex 16

# Database password
openssl rand -base64 24
```

### Secret Rotation

- [x] JWT secrets can be rotated (old tokens invalidated)
- [x] Panel API keys can be rotated (re-encrypt with new key)
- [x] API keys can be revoked without affecting others
- [x] Refresh token families allow granular revocation

### Production Secret Storage

- **Development:** `.env` file (gitignored)
- **Staging/Production:** Use a secrets manager:
  - Docker Swarm secrets
  - Kubernetes secrets (with encryption at rest)
  - HashiCorp Vault
  - AWS Secrets Manager / Parameter Store

---

## Infrastructure Security

### Docker Security

- [x] Multi-stage build (no build tools in production image)
- [x] Non-root user (`nestjs:nodejs`, UID 1001)
- [x] `dumb-init` for proper PID 1 signal handling
- [x] Minimal base image (`node:20-alpine`)
- [x] `.dockerignore` prevents leaking secrets into image

### Network Security

- [x] Docker network isolation (services on private network)
- [x] Only NGINX exposes ports (80, 443) to host
- [x] PostgreSQL, Redis, MinIO not exposed externally (remove port mappings in production)
- [x] Firewall: allow only ports 22, 80, 443

### Database Security

- [x] Database runs as non-root user
- [x] Application uses least-privilege DB user
- [x] Connection string includes SSL in production
- [x] Regular security patches applied

### Redis Security

- [x] Redis requires password in production (`REDIS_PASSWORD`)
- [x] Max memory configured (`maxmemory 512mb`)
- [x] Eviction policy configured (`allkeys-lru`)
- [x] AOF persistence enabled (`appendonly yes`)

---

## Audit & Monitoring

### Audit Logging

- [x] `AuditService` logs authentication events (login, logout, failed attempts)
- [x] `JobLog` records all background job executions
- [x] Sensitive operations logged (wallet mutations, payment verifications)
- [x] API key usage tracked (`lastUsedAt`)

### Security Monitoring

- [x] Failed authentication attempts logged
- [x] Rate limit violations logged
- [x] Panel API errors logged with context
- [x] Pino structured logs enable easy alerting

### Recommended Alerts

| Metric | Threshold | Action |
|--------|-----------|--------|
| Failed logins (5 min) | > 20 | Possible brute force |
| 429 responses (5 min) | > 100 | DDoS or client misconfiguration |
| 500 errors (5 min) | > 10 | Application instability |
| Panel API errors (10 min) | > 5 | Panel connectivity issues |
| DB connections | > 80% of pool | Scale or investigate |
| Redis memory | > 90% | Scale or clear cache |

---

## Pre-Deployment Checklist

### Secrets & Configuration

- [ ] All JWT secrets are strong random values (not default)
- [ ] `ENCRYPTION_KEY` is set and is a strong random value
- [ ] Database password is strong
- [ ] Redis password is set (non-empty)
- [ ] Telegram bot token is valid
- [ ] Payment gateway credentials are correct
- [ ] `NODE_ENV=production`
- [ ] `APP_URL` matches your actual domain
- [ ] `CORS_ORIGINS` set to your actual frontend domains

### Transport Security

- [ ] SSL/TLS certificate installed and valid
- [ ] HTTP redirects to HTTPS
- [ ] HSTS header enabled
- [ ] Security headers present in responses

### Infrastructure

- [ ] Docker containers run as non-root user
- [ ] Database not exposed to public internet
- [ ] Redis not exposed to public internet
- [ ] Firewall configured (only ports 22, 80, 443)
- [ ] SSH key-based auth (password auth disabled)

### Application

- [ ] Swagger docs disabled in production (`NODE_ENV=production`)
- [ ] Database migrations applied
- [ ] Super admin account created with strong password
- [ ] Default/seed data removed or secured
- [ ] Error messages don't leak stack traces in production
- [ ] Pino logs are JSON format (no pretty print)

### Backups

- [ ] Database backup automated (daily minimum)
- [ ] Backup restoration tested
- [ ] Backups stored off-site
- [ ] Redis persistence (AOF) enabled

### Monitoring

- [ ] Health check endpoint returns 200
- [ ] Log aggregation configured
- [ ] Uptime monitoring configured
- [ ] Error tracking (Sentry) configured
- [ ] Alert thresholds set

---

## Vulnerability Reporting

If you discover a security vulnerability:

1. **DO NOT** open a public GitHub issue
2. Email security@your-domain.com with details
3. Allow 48 hours for initial response
4. Do not exploit the vulnerability

We follow responsible disclosure and will credit reporters.

---

## Regular Security Maintenance

| Task | Frequency |
|------|-----------|
| Update Node.js to latest LTS | Monthly |
| Update npm dependencies | Weekly (`npm audit`) |
| Update Docker base images | Monthly |
| Rotate JWT secrets | Quarterly |
| Review admin permissions | Monthly |
| Penetration testing | Annually |
| Security training | Annually |
