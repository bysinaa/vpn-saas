# VPN SaaS - Deployment Guide

## Prerequisites

- Docker & Docker Compose installed on your Linux server
- Domain name pointed to your server (optional, for SSL)
- Git (for cloning the repository)

## Quick Start

### 1. Clone the Repository

```bash
git clone <your-private-repo-url> vpn-saas
cd vpn-saas
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your production values:

```bash
# Application
NODE_ENV=production
APP_PORT=3000
APP_URL=https://your-domain.com

# Database (PostgreSQL)
DATABASE_URL=postgresql://vpn_user:strong_password@localhost:5432/vpn_saas?schema=public
DB_USER=vpn_user
DB_PASSWORD=strong_password
DB_NAME=vpn_saas

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT Secrets (generate strong random strings)
JWT_ACCESS_SECRET=<random-64-char-string>
JWT_REFRESH_SECRET=<random-64-char-string>

# Telegram Bot
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_ADMIN_IDS=<your-telegram-user-id>

# VPN Panel (3x-ui / Sanity)
SANITY_PANEL_BASE_URL=https://your-panel-domain.com
SANITY_PANEL_USERNAME=<panel-admin-username>
SANITY_PANEL_PASSWORD=<panel-admin-password>

# Storage (MinIO - auto-provisioned via docker-compose)
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin

# Payment Gateways (configure as needed)
ONLINE_GATEWAY_ENABLED=false
CRYPTO_ENABLED=false
CARD_TO_CARD_ENABLED=true
```

### 3. Generate Strong Secrets

```bash
# Generate JWT secrets
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# Copy the output for JWT_ACCESS_SECRET and JWT_REFRESH_SECRET

# Generate encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy the output for ENCRYPTION_KEY
```

### 4. Start Services

```bash
docker compose up -d
```

### 5. Run Database Migrations

```bash
docker exec vpn-saas-app npx prisma migrate deploy
```

### 6. Seed the Database (First Time)

```bash
docker exec vpn-saas-app npx prisma db seed
```

## Verification

Check service health:

```bash
curl http://localhost:3000/health
```

View logs:

```bash
docker compose logs -f app
```

## SSL with Let's Encrypt (Recommended)

Edit `nginx/conf.d/default.conf` to add your domain and SSL settings, then:

```bash
# Install certbot on the server
sudo apt install certbot python3-certbot-nginx

# Obtain SSL certificate
sudo certbot --nginx -d your-domain.com

# Restart nginx
docker compose restart nginx
```

## Backup & Restore

### Database Backup

```bash
docker exec vpn-saas-postgres pg_dump -U vpn_user vpn_saas > backup_$(date +%Y%m%d).sql
```

### Restore Database

```bash
cat backup_20240101.sql | docker exec -i vpn-saas-postgres psql -U vpn_user vpn_saas
```

## Stopping the Service

```bash
docker compose down
```

To remove all data (⚠️ destructive):

```bash
docker compose down -v
```

## Updating the Service

```bash
cd /path/to/vpn-saas
git pull
docker compose build
docker compose up -d
docker exec vpn-saas-app npx prisma migrate deploy
```

## Troubleshooting

### Application won't start

```bash
# Check logs
docker compose logs app

# Restart services
docker compose restart
```

### Database connection issues

```bash
# Check PostgreSQL is running
docker exec vpn-saas-postgres pg_isready -U vpn_user -d vpn_saas

# View PostgreSQL logs
docker compose logs postgres
```

### Redis connection issues

```bash
# Check Redis is running
docker exec vpn-saas-redis redis-cli ping
# Should return: PONG
```

## Security Recommendations

1. **Change all default passwords** in `.env`
2. **Use firewall** to restrict access (only ports 80, 443, and SSH)
3. **Enable fail2ban** for SSH protection
4. **Regular backups** of the database
5. **Keep Docker images updated**: `docker compose pull && docker compose up -d`
6. **Never commit `.env`** to version control

## Port Reference

| Port | Service          | Notes                           |
|------|------------------|---------------------------------|
| 80   | Nginx            | HTTP (redirects to HTTPS)       |
| 443  | Nginx            | HTTPS                           |
| 3000 | NestJS App       | Internal API                    |
| 5432 | PostgreSQL       | Internal only                   |
| 6379 | Redis            | Internal only                   |
| 9000 | MinIO API        | Internal only                   |
| 9001 | MinIO Console    | Internal only                   |