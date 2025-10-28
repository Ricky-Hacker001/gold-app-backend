declare module "@cashfreepayments/cashfree-sdk" {
    export class Cashfree {
        constructor(baseUrl: string, clientId: string, clientSecret: string);

        // Define the Payouts methods used in admin.ts
        public payout: {
            v1: {
                requestTransfer(transferRequest: any): Promise<any>;
                // Add other Payouts methods if used, e.g., getTransferStatus(id: string): Promise<any>;
            };
        };
        // Add other properties/methods as needed
    }
    // You may also need to export CFEnvironment if your code uses it, or define it separately
    export const CFEnvironment: any;
}