declare module "*.css";

declare module "jsonwebtoken" {
  export function sign(
    payload: object,
    secret: string,
    options?: { expiresIn?: number | string }
  ): string;
  export function verify(token: string, secret: string): object;
  export function decode(token: string): object | null;
}
