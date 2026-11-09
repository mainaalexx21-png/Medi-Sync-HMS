import crypto from 'node:crypto';
import { env } from '../env';
import { AppError } from '../lib/errors';

/**
 * Payment-gateway abstraction.
 *
 * `StubGateway` completes instantly in dev/test so the whole billing flow is
 * runnable offline. `MpesaGateway` implements the Daraja STK-push handshake but
 * is inert until credentials are configured - swapping it in requires no
 * changes to the billing module.
 */
export interface PaymentInitiation {
  amount: number;
  currency: string;
  phone?: string;
  reference: string;
  description: string;
}

export interface PaymentInitiationResult {
  status: 'COMPLETED' | 'PENDING';
  providerReference: string;
  message: string;
}

export interface PaymentGateway {
  readonly name: string;
  initiate(input: PaymentInitiation): Promise<PaymentInitiationResult>;
}

class StubGateway implements PaymentGateway {
  readonly name = 'STUB';
  async initiate(input: PaymentInitiation): Promise<PaymentInitiationResult> {
    return {
      status: 'COMPLETED',
      providerReference: `STUB-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      message: `Simulated ${input.currency} ${input.amount.toFixed(2)} payment (development gateway).`,
    };
  }
}

class MpesaGateway implements PaymentGateway {
  readonly name = 'MPESA';

  private configured() {
    const { consumerKey, consumerSecret, shortcode, passkey } = env.mpesa;
    return Boolean(consumerKey && consumerSecret && shortcode && passkey);
  }

  private async accessToken(): Promise<string> {
    const auth = Buffer.from(`${env.mpesa.consumerKey}:${env.mpesa.consumerSecret}`).toString('base64');
    const base = env.mpesa.sandbox ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
    const res = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new AppError(502, 'MPESA_AUTH_FAILED', 'Could not authenticate with M-Pesa');
    const body = (await res.json()) as { access_token: string };
    return body.access_token;
  }

  async initiate(input: PaymentInitiation): Promise<PaymentInitiationResult> {
    if (!this.configured()) {
      throw new AppError(
        503,
        'MPESA_NOT_CONFIGURED',
        'M-Pesa is not configured on this deployment. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE and MPESA_PASSKEY.',
      );
    }
    if (!input.phone) throw new AppError(400, 'PHONE_REQUIRED', 'A phone number is required for M-Pesa payment');
    const base = env.mpesa.sandbox ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke';
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const password = Buffer.from(`${env.mpesa.shortcode}${env.mpesa.passkey}${timestamp}`).toString('base64');
    const token = await this.accessToken();

    const res = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: env.mpesa.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(input.amount),
        PartyA: input.phone,
        PartyB: env.mpesa.shortcode,
        PhoneNumber: input.phone,
        CallBackURL: `${env.appOrigin}/api/v1/payments/mpesa/callback`,
        AccountReference: input.reference.slice(0, 12),
        TransactionDesc: input.description.slice(0, 60),
      }),
    });
    const body = (await res.json()) as { CheckoutRequestID?: string; ResponseDescription?: string };
    if (!res.ok || !body.CheckoutRequestID) {
      throw new AppError(502, 'MPESA_REQUEST_FAILED', body.ResponseDescription ?? 'M-Pesa request failed');
    }
    return {
      status: 'PENDING',
      providerReference: body.CheckoutRequestID,
      message: 'Check your phone and enter your M-Pesa PIN to complete payment.',
    };
  }
}

export function gatewayFor(method: string): PaymentGateway {
  switch (method) {
    case 'MPESA':
      return new MpesaGateway();
    case 'CARD':
      // A card PSP would be added here (Stripe/Flutterwave/etc.).
      return new StubGateway();
    default:
      return new StubGateway();
  }
}
