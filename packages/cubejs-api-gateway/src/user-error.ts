import { CubejsHandlerError } from './cubejs-handler-error';

export type DeniedMemberInfo = {
  member: string;
  title: string;
  displayTitle: string;
};

export class UserError extends CubejsHandlerError {
  public constructor(message: string, extensions?: Record<string, unknown>) {
    super(400, 'User Error', message, undefined, extensions);
  }
}
