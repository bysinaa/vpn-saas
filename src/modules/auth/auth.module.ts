import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PasswordService } from './password.service';
import { JwtTokenService } from './jwt-token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthorizationGuard } from './guards/authorization.guard';
import { config } from '@/config';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: config.jwt.accessSecret,
        signOptions: {
          issuer: config.jwt.issuer,
          audience: config.jwt.audience,
          expiresIn: config.jwt.accessTtl,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    JwtTokenService,
    JwtAuthGuard,
    AuthorizationGuard,
    // Global guards: every route requires JWT unless @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
  ],
  exports: [AuthService, PasswordService, JwtTokenService, JwtAuthGuard, AuthorizationGuard],
})
export class AuthModule {}
