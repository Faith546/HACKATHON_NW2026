export type Mandate = {
  operationId: string;
  version: number;
  fixture: true;
  currency: string;
  maxTotalMinor: number;
  allInRequired: true;
  pickup: {
    date: string;
    windowStart: string;
    windowEnd: string;
    timezone: string;
  };
};
