import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { config } from '@/config';

/**
 * PasswordService - centralizes hashing/comparison so rounds are configurable.
 */
@Injectable()
export class PasswordService {
  private readonly rounds = config.security.bcryptRounds;

  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  async compare(plain: string, hash: string): Promise<boolean> {
    if (!hash) return false;
    return bcrypt.compare(plain, hash);
  }
}
