import { HttpStatus, PipeTransform } from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';
import { BusinessException } from '@/common/exceptions/business.exception';

/**
 * Generic validation pipe using a Zod schema.
 * Usage: @Body(new ZodValidationPipe(mySchema))
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      throw new BusinessException('VALIDATION_ERROR', 'Validation failed', HttpStatus.BAD_REQUEST, issues);
    }
    return result.data;
  }
}

export { ZodError };
