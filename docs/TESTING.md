# 🧪 Testing Strategy

Comprehensive testing strategy for the VPN SaaS Platform.

---

## Table of Contents

1. [Testing Philosophy](#testing-philosophy)
2. [Test Pyramid](#test-pyramid)
3. [Unit Testing](#unit-testing)
4. [Integration Testing](#integration-testing)
5. [E2E Testing](#e2e-testing)
6. [Test Environment Setup](#test-environment-setup)
7. [Mocking Strategy](#mocking-strategy)
8. [Coverage Requirements](#coverage-requirements)
9. [Running Tests](#running-tests)
10. [Writing Tests](#writing-tests)

---

## Testing Philosophy

We follow a **pragmatic testing approach**:

1. **Test business logic, not framework** — services contain the logic; controllers are thin
2. **Mock external dependencies** — databases, Redis, external APIs are mocked in unit tests
3. **Use real dependencies in integration tests** — real PostgreSQL + Redis for true integration
4. **Test behavior, not implementation** — verify what the code does, not how it does it
5. **Fast feedback** — unit tests run in seconds; integration tests in minutes

---

## Test Pyramid

```
        /\
       /  \        E2E Tests (few)
      /----\       - Full HTTP request → response cycle
     /      \      - Real services via Docker
    /--------\     Integration Tests (some)
   /          \    - Real DB + Redis
  /------------\   - Module-level tests
 /              \  Unit Tests (many)
/________________\ - Pure logic, mocked dependencies
```

| Level | Count | Speed | Scope |
|-------|-------|-------|-------|
| Unit | 200+ | < 10s | Single service/function |
| Integration | 50+ | < 60s | Module with real DB |
| E2E | 20+ | < 120s | Full HTTP request |

---

## Unit Testing

### Framework: Jest

Unit tests focus on individual services in isolation. All external dependencies (Prisma, Redis, queues) are mocked.

### Example: WalletService Unit Test

```typescript
// src/modules/wallet/wallet.service.spec.ts
import { Test } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { PrismaService } from '@/common/prisma/prisma.service';

describe('WalletService', () => {
  let service: WalletService;
  let prisma: { withTransaction: jest.Mock; wallet: any };

  beforeEach(async () => {
    prisma = {
      withTransaction: jest.fn(),
      wallet: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(WalletService);
  });

  describe('getBalance', () => {
    it('should return wallet balance', async () => {
      prisma.wallet.findUnique.mockResolvedValue({
        id: 1n,
        balanceMinor: 50000n,
      });

      const result = await service.getBalance(1n);

      expect(result.balanceMinor).toBe(50000n);
      expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
        where: { userId: 1n },
      });
    });

    it('should create wallet if not exists', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);
      prisma.wallet.create.mockResolvedValue({
        id: 1n,
        balanceMinor: 0n,
      });

      const result = await service.getBalance(1n);

      expect(result.balanceMinor).toBe(0n);
      expect(prisma.wallet.create).toHaveBeenCalled();
    });
  });

  describe('mutateBalance - debit', () => {
    it('should throw WALLET_INSUFFICIENT_FUNDS when balance too low', async () => {
      prisma.withTransaction.mockImplementation(async (fn) => {
        const tx = {
          wallet: {
            findUnique: jest.fn().mockResolvedValue({ balanceMinor: 100n }),
          },
        };
        return fn(tx);
      });

      await expect(
        service.mutateBalance({
          userId: 1n,
          amount: -200n,
          type: 'DEBIT',
          reason: 'PURCHASE',
        }),
      ).rejects.toThrow('Insufficient');
    });
  });
});
```

### Example: Auth Guard Unit Test

```typescript
// src/modules/auth/guards/jwt-auth.guard.spec.ts
describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let tokens: { verifyAccess: jest.Mock };
  let auth: { getStatus: jest.Mock; getPermissions: jest.Mock };

  beforeEach(() => {
    tokens = { verifyAccess: jest.fn() };
    auth = { getStatus: jest.fn(), getPermissions: jest.fn() };
    guard = new JwtAuthGuard(reflector, tokens, auth);
  });

  it('should allow @Public routes', async () => {
    const context = createMockContext({ isPublic: true });
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('should reject missing token', async () => {
    const context = createMockContext({ isPublic: false, headers: {} });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should verify and attach user', async () => {
    tokens.verifyAccess.mockResolvedValue({ sub: '1', role: 'USER' });
    auth.getStatus.mockResolvedValue('ACTIVE');
    auth.getPermissions.mockResolvedValue([]);

    const context = createMockContext({
      isPublic: false,
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(await guard.canActivate(context)).toBe(true);
  });
});
```

---

## Integration Testing

Integration tests use a real PostgreSQL + Redis instance (via Docker) to test the full stack.

### Setup

```typescript
// test/setup.ts
import { PrismaService } from '@/common/prisma/prisma.service';

let prisma: PrismaService;

beforeAll(async () => {
  prisma = new PrismaService();
  await prisma.$connect();
  // Run migrations
  await prisma.$executeRawUnsafe('TRUNCATE users, wallets CASCADE');
});

afterAll(async () => {
  await prisma.$disconnect();
});

afterEach(async () => {
  // Clean up between tests
  await prisma.$executeRawUnsafe('TRUNCATE users, wallets CASCADE');
});
```

### Example: Auth Integration Test

```typescript
// test/integration/auth.e2e-spec.ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '@/app.module';

describe('Auth (Integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /auth/register', () => {
    it('should register a new user', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: 'test@example.com',
          password: 'SecurePass123!',
          username: 'testuser',
        })
        .expect(201);

      expect(res.body.user.email).toBe('test@example.com');
      expect(res.body.tokens.accessToken).toBeDefined();
      expect(res.body.tokens.refreshToken).toBeDefined();
    });

    it('should reject duplicate email', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'test@example.com', password: 'SecurePass123!' })
        .expect(409);
    });
  });

  describe('POST /auth/login', () => {
    it('should login with valid credentials', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'test@example.com', password: 'SecurePass123!' })
        .expect(200);

      expect(res.body.tokens.accessToken).toBeDefined();
    });

    it('should reject invalid password', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'test@example.com', password: 'wrong' })
        .expect(401);
    });
  });
});
```

### Example: Wallet Integration Test

```typescript
// test/integration/wallet.e2e-spec.ts
describe('Wallet (Integration)', () => {
  let app: INestApplication;
  let authToken: string;
  let userId: string;

  beforeAll(async () => {
    // Setup app + register user
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'wallet@example.com', password: 'SecurePass123!' });

    authToken = register.body.tokens.accessToken;
    userId = register.body.user.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return zero balance for new user', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/wallet')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(res.body.balanceMinor).toBe('0');
  });

  it('should reject unauthorized access', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/wallet')
      .expect(401);
  });
});
```

---

## E2E Testing

E2E tests verify the complete user journey through the HTTP API.

### Example: Purchase Flow E2E

```typescript
// test/e2e/purchase-flow.e2e-spec.ts
describe('Purchase Flow (E2E)', () => {
  let app: INestApplication;
  let userToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    // Register user
    const user = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'user@example.com', password: 'SecurePass123!' });
    userToken = user.body.tokens.accessToken;

    // Login as admin (seeded)
    const admin = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'admin-password' });
    adminToken = admin.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('should complete full purchase flow', async () => {
    // 1. List plans
    const plans = await request(app.getHttpServer())
      .get('/api/v1/plans')
      .expect(200);
    const planId = plans.body[0].publicId;

    // 2. Create order
    const order = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ planPublicId: planId, type: 'NEW', paymentMethod: 'WALLET' })
      .expect(201);

    // 3. Pay with wallet (would need wallet balance)
    // ... continue flow
  });
});
```

---

## Test Environment Setup

### Jest Configuration

```javascript
// jest.config.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.spec.ts',
    '!src/main.ts',
  ],
  coverageDirectory: './coverage',
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
```

### Docker Compose for Tests

```yaml
# docker-compose.test.yml
services:
  postgres-test:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: vpn_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - '5433:5432'  # Different port to avoid conflicts

  redis-test:
    image: redis:7-alpine
    ports:
      - '6380:6379'  # Different port
```

### Test Database Setup

```bash
# Start test databases
docker-compose -f docker-compose.test.yml up -d

# Run migrations on test DB
DATABASE_URL=postgresql://test:test@localhost:5433/vpn_test npx prisma migrate deploy

# Run tests
npm test
```

---

## Mocking Strategy

### PrismaService Mock

```typescript
// test/mocks/prisma.mock.ts
export const mockPrismaService = {
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  wallet: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  withTransaction: jest.fn().mockImplementation(async (fn) => {
    // Pass the same mock as the transaction client
    return fn(mockPrismaService);
  }),
  $queryRaw: jest.fn(),
};
```

### RedisService Mock

```typescript
// test/mocks/redis.mock.ts
export const mockRedisService = {
  get: jest.fn(),
  getJson: jest.fn().mockResolvedValue(null),
  set: jest.fn(),
  setJson: jest.fn(),
  del: jest.fn(),
  cached: jest.fn().mockImplementation(async (_key, _ttl, loader) => loader()),
  incr: jest.fn(),
  exists: jest.fn(),
};
```

### Queue Mock

```typescript
// test/mocks/queue.mock.ts
export const mockQueue = {
  add: jest.fn(),
  addBulk: jest.fn(),
  getJob: jest.fn(),
  getJobs: jest.fn().mockResolvedValue([]),
};
```

---

## Coverage Requirements

| Layer | Minimum Coverage |
|-------|-----------------|
| Services (business logic) | 85% |
| Controllers | 70% |
| Guards | 90% |
| Utilities | 95% |
| Overall | 80% |

### Coverage Report

```bash
npm test -- --coverage
```

Reports are generated in `coverage/` directory:
- `coverage/lcov-report/index.html` — HTML report
- `coverage/lcov.info` — for CI integration (Codecov, Coveralls)

---

## Running Tests

### All Tests

```bash
npm test
```

### Watch Mode

```bash
npm run test:watch
```

### Specific Test File

```bash
npx jest src/modules/wallet/wallet.service.spec.ts
```

### With Coverage

```bash
npm test -- --coverage
```

### Integration Tests

```bash
# Start test databases
docker-compose -f docker-compose.test.yml up -d

# Run migrations
DATABASE_URL=postgresql://test:test@localhost:5433/vpn_test npx prisma migrate deploy

# Run integration tests
npm run test:e2e
```

### CI Pipeline Tests

```bash
# Lint + type check
npm run lint
npx tsc --noEmit

# Unit tests
npm test -- --coverage

# Integration tests (with Docker services)
npm run test:e2e
```

---

## Writing Tests

### Naming Convention

```
src/modules/<feature>/<feature>.service.spec.ts          # Unit test
src/modules/<feature>/<feature>.controller.spec.ts      # Unit test
test/integration/<feature>.e2e-spec.ts                   # Integration test
test/e2e/<flow-name>.e2e-spec.ts                        # E2E test
```

### Test Structure (AAA Pattern)

```typescript
describe('MethodName', () => {
  it('should <expected behavior> when <condition>', async () => {
    // Arrange
    mockDependency.method.mockResolvedValue(expectedValue);

    // Act
    const result = await service.methodName(input);

    // Assert
    expect(result).toEqual(expected);
    expect(mockDependency.method).toHaveBeenCalledWith(input);
  });
});
```

### Best Practices

1. **One assertion per test** (when possible) — easier to identify failures
2. **Descriptive test names** — `should return 404 when user not found`
3. **Setup in `beforeEach`** — clean state for each test
4. **Teardown in `afterEach`** — clean up resources
5. **Mock return values** — use realistic data, not empty objects
6. **Test edge cases** — null, undefined, empty strings, boundary values
7. **Test error paths** — not just happy paths
8. **Avoid testing implementation details** — test behavior
9. **Use factories** — for complex test data setup
10. **Keep tests fast** — mock I/O, avoid unnecessary awaits
