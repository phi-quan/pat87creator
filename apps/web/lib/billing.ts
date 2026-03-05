export type SubscriptionPlan = 'starter' | 'creator' | 'pro';

export type PlanDefinition = {
  key: SubscriptionPlan;
  label: string;
  monthlyCredits: number;
  stripePriceEnv: string;
};

export const PLAN_DEFINITIONS: PlanDefinition[] = [
  { key: 'starter', label: 'Starter', monthlyCredits: 10, stripePriceEnv: 'STRIPE_PRICE_STARTER' },
  { key: 'creator', label: 'Creator', monthlyCredits: 50, stripePriceEnv: 'STRIPE_PRICE_CREATOR' },
  { key: 'pro', label: 'Pro', monthlyCredits: 200, stripePriceEnv: 'STRIPE_PRICE_PRO' }
];

export const PLAN_BY_KEY: Record<SubscriptionPlan, PlanDefinition> = {
  starter: PLAN_DEFINITIONS[0],
  creator: PLAN_DEFINITIONS[1],
  pro: PLAN_DEFINITIONS[2]
};

const DEFAULT_VIDEO_JOB_COST = 10;

export function getVideoJobCost(): number {
  const rawValue = process.env.VIDEO_JOB_COST;
  if (!rawValue) {
    return DEFAULT_VIDEO_JOB_COST;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_VIDEO_JOB_COST;
  }

  return parsed;
}

export function parsePlan(input: unknown): SubscriptionPlan | null {
  if (input === 'starter' || input === 'creator' || input === 'pro') {
    return input;
  }

  return null;
}
