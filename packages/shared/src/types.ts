export type AppEnvironment = 'development' | 'staging' | 'production';

export interface AppConfig {
  name: string;
  env: AppEnvironment;
}
