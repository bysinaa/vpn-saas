# 📡 API Reference

Complete REST API reference for the VPN SaaS Platform.

**Base URL:** `https://your-domain.com/api/v1`  
**Auth:** Bearer JWT (`Authorization: Bearer <access_token>`) or API Key (`X-API-Key: <key>`)  
**Content-Type:** `application/json`

> Interactive Swagger UI available at `/api/v1/docs` (non-production environments)

---

## Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | — | Register with email + password |
| POST | `/auth/login` | — | Login with email/telegramId + password |
| POST | `/auth/refresh` | Refresh Token | Refresh access token |
| POST | `/auth/logout` | Bearer | Revoke session |
| GET | `/auth/me` | Bearer | Get current user profile |

### Register

```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "username": "johndoe",
  "referralCode": "ABC123"
}
```

**Response (200):**
```json
{
  "user": { "id": "1", "publicId": "uuid", "role": "USER", "language": "EN" },
  "tokens": { "accessToken": "...", "refreshToken": "...", "expiresIn": 900 }
}
```

---

## Users

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/users/me` | Bearer | Get my profile |
| PATCH | `/users/me` | Bearer | Update my profile |
| GET | `/users/me/referral` | Bearer | Get my referral code + stats |

---

## Wallet

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/wallet` | Bearer | Get wallet balance |
| GET | `/wallet/transactions` | Bearer | List transactions (paginated) |

**Money is in minor units (BigInt).** For example, 100.00 IRR = `10000` minor units.

---

## Plans

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/plans/categories` | — | List plan categories |
| GET | `/plans` | — | List visible plans |
| GET | `/plans/:slug` | — | Get plan by slug |
| POST | `/admin/plans` | `manage:plans` | Create plan |
| PATCH | `/admin/plans/:publicId` | `manage:plans` | Update plan |
| DELETE | `/admin/plans/:publicId` | `manage:plans` | Delete plan |

---

## Orders

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/orders` | Bearer | Create order |
| POST | `/orders/:publicId/pay-wallet` | Bearer | Pay order with wallet |
| DELETE | `/orders/:publicId` | Bearer | Cancel pending order |
| GET | `/orders/mine` | Bearer | List my orders |
| GET | `/orders/:publicId` | Bearer | Get order details |
| GET | `/orders/admin/all` | `read:orders` | List all orders |

### Create Order

```http
POST /api/v1/orders
Authorization: Bearer <token>

{
  "planPublicId": "uuid-here",
  "type": "NEW",
  "quantity": 1,
  "paymentMethod": "WALLET",
  "giftForUserPublicId": null
}
```

---

## Subscriptions

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/subscriptions/mine` | Bearer | List my subscriptions |
| GET | `/subscriptions/:publicId` | Bearer | Get subscription details |
| POST | `/subscriptions/:publicId/renew` | Bearer | Renew subscription |
| POST | `/subscriptions/:publicId/pause` | Bearer | Pause subscription |
| POST | `/subscriptions/:publicId/resume` | Bearer | Resume subscription |
| POST | `/subscriptions/:publicId/reset-traffic` | Bearer | Reset traffic counter |
| POST | `/subscriptions/:publicId/transfer` | Bearer | Transfer to another user |
| GET | `/subscriptions/admin/all` | `read:subscriptions` | List all subscriptions |

---

## VPN

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/vpn/config/:subscriptionPublicId` | Bearer | Get VPN connection config |
| GET | `/vpn/usage/:subscriptionPublicId` | Bearer | Get traffic usage stats |

---

## Payments

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/payments/initiate` | Bearer | Initiate payment (online/crypto/card) |
| POST | `/payments/receipts` | Bearer | Upload card-to-card receipt |
| GET | `/payments/mine` | Bearer | List my payments |
| GET | `/payments/:publicId` | Bearer | Get payment details |
| GET | `/payments/admin/receipts` | `read:payments` | List pending receipts |
| POST | `/payments/admin/receipts/:id/verify` | `manage:payments` | Approve/reject receipt |
| POST | `/payments/voucher/redeem` | Bearer | Redeem voucher code |
| GET | `/payments/online/callback` | — | Payment gateway callback (@Public) |

### Initiate Online Payment

```http
POST /api/v1/payments/initiate
Authorization: Bearer <token>

{
  "orderId": "order-uuid",
  "method": "ONLINE",
  "gateway": "zarinpal"
}
```

**Response:**
```json
{
  "publicId": "payment-uuid",
  "status": "PENDING",
  "gatewayRedirectUrl": "https://gateway.zarinpal.com/StartPay/..."
}
```

---

## Servers (Public Catalog)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/servers/countries` | — | List countries with servers |
| GET | `/servers/cities` | — | List cities |
| GET | `/servers` | — | List available servers |
| GET | `/servers/:id` | — | Get server details |

---

## Panels (Admin)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/admin/panels` | `read:panels` | List panels |
| POST | `/admin/panels` | `manage:panels` | Add panel |
| PATCH | `/admin/panels/:id` | `manage:panels` | Update panel |
| DELETE | `/admin/panels/:id` | `manage:panels` | Remove panel |
| POST | `/admin/panels/:id/health` | `read:panels` | Check panel health |

---

## Notifications

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/notifications/mine` | Bearer | List my notifications |
| GET | `/notifications/unread-count` | Bearer | Get unread count |
| POST | `/notifications/:publicId/read` | Bearer | Mark as read |
| POST | `/notifications/read-all` | Bearer | Mark all as read |
| DELETE | `/notifications/:publicId` | Bearer | Delete notification |

---

## Broadcasts (Admin)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/broadcasts` | `manage:notifications` | Create broadcast |
| GET | `/broadcasts` | `read:notifications` | List broadcasts |
| GET | `/broadcasts/:publicId` | `read:notifications` | Get broadcast details |
| POST | `/broadcasts/:publicId/cancel` | `manage:notifications` | Cancel broadcast |

### Create Broadcast

```http
POST /api/v1/broadcasts
Authorization: Bearer <admin_token>

{
  "title": "Maintenance Notice",
  "message": "Service will be unavailable on Sunday 2-4 AM.",
  "channel": "TELEGRAM",
  "targetType": "ACTIVE_SUBS",
  "scheduledAt": "2024-01-15T10:00:00Z"
}
```

---

## Admin Dashboard

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/admin/dashboard` | `read:dashboard` | Aggregate stats |
| GET | `/admin/revenue-series` | `read:dashboard` | Revenue time series |
| GET | `/admin/user-growth` | `read:dashboard` | User growth time series |

---

## Affiliate

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/affiliate/apply` | Bearer | Apply for affiliate account |
| GET | `/affiliate/me` | Bearer | Get my affiliate account |
| GET | `/affiliate/me/commissions` | Bearer | List my commissions |
| POST | `/affiliate/me/payout` | Bearer | Request commission payout |
| GET | `/affiliate/admin/accounts` | `read:affiliates` | List all affiliate accounts |
| GET | `/affiliate/admin/referrals` | `read:affiliates` | List referrals |

---

## Tickets

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/tickets` | Bearer | Create support ticket |
| POST | `/tickets/:publicId/reply` | Bearer | Reply to ticket |
| GET | `/tickets/:publicId/messages` | Bearer | Get ticket messages |
| GET | `/tickets/mine` | Bearer | List my tickets |
| GET | `/tickets/admin/all` | `read:tickets` | List all tickets |
| POST | `/tickets/admin/:publicId/reply` | `reply:tickets` | Agent reply |
| PATCH | `/tickets/admin/:publicId/status` | `manage:tickets` | Update ticket status |

---

## Education

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/education/articles` | — | List published articles |
| GET | `/education/articles/:slug` | — | Get article by slug |
| POST | `/education/articles/:slug/helpful` | Bearer | Mark article helpful |
| GET | `/education/progress` | Bearer | Get onboarding progress |

---

## Analytics

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/analytics/metrics` | `read:analytics` | List available metrics |
| GET | `/analytics/series` | `read:analytics` | Get time series |
| GET | `/analytics/summary` | `read:analytics` | Get latest metric summary |
| POST | `/analytics/snapshot` | `manage:analytics` | Trigger daily snapshot |

---

## Reports

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/reports/revenue` | `read:reports` | Generate revenue CSV |
| POST | `/reports/subscriptions` | `read:reports` | Generate subscriptions CSV |
| POST | `/reports/users` | `read:reports` | Generate users CSV |

### Generate Revenue Report

```http
POST /api/v1/reports/revenue
Authorization: Bearer <admin_token>

{
  "from": "2024-01-01T00:00:00Z",
  "to": "2024-01-31T23:59:59Z",
  "groupBy": "day"
}
```

**Response:**
```json
{
  "fileKey": "reports/revenue/2024-01-15/uuid.csv",
  "downloadUrl": "https://s3.../signed-url...",
  "rows": 31,
  "format": "csv",
  "generatedAt": "2024-01-15T12:00:00Z"
}
```

---

## Settings

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/settings/public` | — | Get public settings |
| GET | `/admin/settings` | `read:settings` | List all settings |
| GET | `/admin/settings/:key` | `read:settings` | Get setting by key |
| POST | `/admin/settings` | `manage:settings` | Upsert setting |
| DELETE | `/admin/settings/:key` | `manage:settings` | Delete setting |
| GET | `/admin/flags` | `read:settings` | List feature flags |
| PATCH | `/admin/flags/:key` | `manage:settings` | Update feature flag |
| DELETE | `/admin/flags/:key` | `manage:settings` | Delete feature flag |

---

## API Keys

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api-keys` | Bearer | Create API key |
| GET | `/api-keys/mine` | Bearer | List my API keys |
| PATCH | `/api-keys/:publicId` | Bearer | Update API key |
| POST | `/api-keys/:publicId/revoke` | Bearer | Revoke API key |
| DELETE | `/api-keys/:publicId` | Bearer | Delete API key |
| GET | `/api-keys/admin/all` | `read:api-keys` | List all API keys |

---

## Telegram Bot

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/telegram/webhook` | Secret Token | Telegram webhook receiver (@Public) |

---

## Mini App

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/miniapp/auth` | — | Authenticate via Telegram initData |
| GET | `/miniapp/dashboard` | Bearer | Get dashboard data (user+wallet+subs+plans) |

### Mini App Auth

```http
POST /api/v1/miniapp/auth

{
  "initData": "query_id=...&user=...&auth_date=...&hash=..."
}
```

---

## Health

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | — | Liveness probe |
| GET | `/health/liveness` | — | Kubernetes liveness |
| GET | `/health/readiness` | — | Kubernetes readiness |

---

## Error Response Format

All errors return a unified envelope:

```json
{
  "success": false,
  "error": {
    "code": "WALLET_INSUFFICIENT_FUNDS",
    "message": "Insufficient wallet balance",
    "details": { "required": "50000", "available": "30000" }
  },
  "timestamp": "2024-01-15T12:00:00.000Z",
  "path": "/api/v1/orders/uuid/pay-wallet"
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Input validation failed |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | State conflict |
| `UNAUTHORIZED` | 401 | Not authenticated |
| `FORBIDDEN` | 403 | Lacking permissions |
| `TOO_MANY_REQUESTS` | 429 | Rate limited |
| `PAYMENT_REQUIRED` | 402 | Payment needed |
| `WALLET_INSUFFICIENT_FUNDS` | 400 | Not enough wallet balance |
| `TRIAL_ALREADY_USED` | 400 | Trial already consumed |
| `SUBSCRIPTION_EXPIRED` | 400 | Subscription expired |
| `PAYMENT_REJECTED` | 400 | Payment rejected |
| `VOUCHER_INVALID` | 400 | Voucher code invalid |
| `VOUCHER_EXPIRED` | 400 | Voucher expired |
| `REFERRAL_INVALID` | 400 | Invalid referral code |
| `PANEL_API_ERROR` | 502 | VPN panel API error |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Pagination

List endpoints accept query parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `page` | 1 | Page number |
| `limit` | 20 | Items per page (max 100) |
| `sort` | `createdAt:desc` | Sort field:direction |

**Response includes meta:**

```json
{
  "data": [...],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8,
    "hasNext": true,
    "hasPrev": false
  }
}
```

---

## Rate Limits

| Endpoint Group | Limit | Window |
|----------------|-------|--------|
| General API | 20 req/s | per IP |
| Auth endpoints | 5 req/s | per IP |
| Telegram webhook | 100 req/s burst | per IP |

Rate limited responses return `429 Too Many Requests` with `Retry-After` header.
