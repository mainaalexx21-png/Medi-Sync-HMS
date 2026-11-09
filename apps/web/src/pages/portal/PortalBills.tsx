import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, downloadFile } from '../../lib/api';
import { dateOnly, money } from '../../lib/format';
import {
  Alert, Button, Card, CardHeader, EmptyState, Loading, Modal, PageHeader, StatusBadge, Table, useToast,
} from '../../components/ui';

export default function PortalBills() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [paying, setPaying] = useState<any | null>(null);
  const [method, setMethod] = useState('MPESA');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const invoices = useQuery({
    queryKey: ['portal-invoices'],
    queryFn: () => api.get<{ data: any[] }>('/me/invoices'),
  });

  async function pay() {
    if (!paying) return;
    setBusy(true);
    try {
      const res = await api.post<any>(`/me/invoices/${paying.id}/pay`, { method, phone: phone || undefined });
      toast.push(
        res.status === 'COMPLETED' ? 'Payment received. Thank you!' : res.message ?? 'Payment pending on your phone.',
        'success',
      );
      setPaying(null);
      queryClient.invalidateQueries({ queryKey: ['portal-invoices'] });
      queryClient.invalidateQueries({ queryKey: ['portal-summary'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Payment could not be started', 'danger');
    } finally {
      setBusy(false);
    }
  }

  const rows = invoices.data?.data ?? [];
  const outstanding = rows.reduce((sum, invoice) => sum + invoice.balance, 0);

  return (
    <div>
      <PageHeader
        title="Bills & payments"
        description="Pay securely online. Receipts are available instantly as PDF."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Outstanding</p>
          <p className="mt-1 text-2xl font-semibold text-rose-700">{money(outstanding)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Invoices</p>
          <p className="mt-1 text-2xl font-semibold">{rows.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Paid</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-700">{rows.filter((invoice) => invoice.balance === 0).length}</p>
        </div>
      </div>

      <Card>
        <CardHeader title="Your invoices" subtitle="Every consultation, lab test and medicine is itemised" />
        {invoices.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState title="No bills yet" description="Invoices appear after your visit." />
        ) : (
          <Table head={['Invoice', 'Date', 'Total', 'Balance', 'Status', '']}>
            {rows.map((invoice) => (
              <tr key={invoice.id}>
                <td className="table-cell font-mono text-xs">{invoice.number}</td>
                <td className="table-cell text-xs">{dateOnly(invoice.issuedAt)}</td>
                <td className="table-cell">
                  {money(invoice.total)}
                  <ul className="mt-1 space-y-0.5 text-[11px] text-slate-500">
                    {invoice.items.slice(0, 4).map((item: any) => (
                      <li key={item.id}>
                        {item.description} · {money(item.amount)}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="table-cell font-medium">{money(invoice.balance)}</td>
                <td className="table-cell">
                  <StatusBadge status={invoice.status} />
                </td>
                <td className="table-cell">
                  <div className="flex flex-col items-end gap-1">
                    {invoice.balance > 0 && (
                      <Button size="sm" onClick={() => setPaying(invoice)}>
                        Pay now
                      </Button>
                    )}
                    {invoice.payments.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => downloadFile(`/me/invoices/${invoice.id}/receipt`, `receipt-${invoice.payments[0].receiptNo}.pdf`)}
                      >
                        Receipt
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal open={Boolean(paying)} onClose={() => setPaying(null)} title="Pay your bill">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Amount due <strong>{money(paying?.balance)}</strong> for invoice {paying?.number}.
          </p>
          <div>
            <label className="label" htmlFor="pay-method">
              Payment method
            </label>
            <select id="pay-method" className="input" value={method} onChange={(event) => setMethod(event.target.value)}>
              <option value="MPESA">M-Pesa</option>
              <option value="CARD">Card</option>
            </select>
          </div>
          {method === 'MPESA' && (
            <div>
              <label className="label" htmlFor="pay-phone">
                M-Pesa phone number
              </label>
              <input id="pay-phone" className="input" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+2547…" />
            </div>
          )}
          <Alert tone="info">
            You will receive a prompt to authorise the payment. In local development the gateway is simulated and completes instantly.
          </Alert>
          <Button onClick={pay} loading={busy}>
            Pay {money(paying?.balance)}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
