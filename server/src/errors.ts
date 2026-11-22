/** 业务错误 → HTTP 状态映射的统一异常。 */
import { HttpException } from '@nestjs/common'

export class BadRequestError extends HttpException {
  constructor(message: string) {
    super(message, 400)
  }
}

export class NotFoundError extends HttpException {
  constructor(message: string) {
    super(message, 404)
  }
}

export class UnauthorizedError extends HttpException {
  constructor(message = '未登录或令牌无效') {
    super(message, 401)
  }
}

export class ForbiddenError extends HttpException {
  constructor(message = '没有执行该操作的权限') {
    super(message, 403)
  }
}

export class ServiceUnavailableError extends HttpException {
  constructor(message: string) {
    super(message, 503)
  }
}
