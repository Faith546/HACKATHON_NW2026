export type Operation = {
  operationId: string;
  fixture: true;
  customerName: string;
  route: {
    origin: string;
    destination: string;
  };
  cargo: {
    description: string;
    quantity: number;
  };
  timezone: string;
  currency: string;
};
