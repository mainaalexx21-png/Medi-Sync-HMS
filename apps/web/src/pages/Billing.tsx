import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateOnly, dateTime, money } from '../lib/format';
import {
  Alert, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, Select,
  StatusBadge, Table, Tabs, useToast,
} from '../components/ui';

export default function Billing() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'all' | 'unpaid'>('unpaid');
  const [paying, setPaying] = useState<any | null>(null);
  const [viewing, setViewing] = useState<any | null>(null);
  const [payment, setPayment] = useState({ amount: '', method: 'MPESA', reference: '' });
  const [busy, setBusy] = useState(false);

  const invoices = useQuery({
    queryKey: ['invoices', tab],
    queryFn: () => api.get<{ data: any[]; pagination: any }>('/invoices', { unpaid: tab === 'unpaid' ? 'true' : undefined, pageSize: 50 }),
  });

  async function recordPayment(event: React.FormEvent) {
    event.preventDefault();
    if (!paying) return;
    setBusy(true);
    try {
      await api.post(`/invoices/${paying.id}/payments`, {
        amount: Number(payment.amount),
        method: payment.method,
        reference: payment.reference || undefined,
      });
      toast.push('Payment recorded', 'success');
      setPaying(null);
      setPayment({ amount: '', method: 'MPESA', reference: '' });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Payment failed', 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function openInvoice(id: string) {
    try {
      const res = await api.get<{ invoice: any }>(`/invoices/${id}`);
      setViewing(res.invoice);
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not open invoice', 'danger');
    }
  }

  async function refund(paymentId: string) {
    const reason = window.prompt('Reason for refund?');
    if (!reason) return;
    try {
      await api.post(`/payments/${paymentId}/refund`, { reason });
      toast.push('Refund recorded', 'success');
      if (viewing) await openInvoice(viewing.id);
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Refund failed', 'danger');
    }
  }

  return (
    <div>
      <PageHeader title="Billing & payments" description="Invoices are generated automatically from clinical activity. Record payments and issue receipts." />
      <Tabs
        value={tab}
        onChange={(next) => setTab(next as 'all' | 'unpaid')}
        tabs={[
          { id: 'unpaid', label: 'Outstanding' },
          { id: 'all', label: 'All invoices' },
        ]}
      />

      <Card className="mt-3">
        <CardHeader
          title={tab === 'unpaid' ? 'Outstanding invoices' : 'All invoices'}
          subtitle={`${invoices.data?.pagination?.total ?? 0} invoices`}
          actions={
            <Button size="sm" variant="outline" onClick={() => invoices.refetch()} loading={invoices.isFetching}>
              Refresh
            </Button>
          }
        />
        {invoices.isLoading ? (
          <Loading />
        ) : (invoices.data?.data ?? []).length === 0 ? (
          <EmptyState title="Nothing outstanding" description="Every invoice has been settled." />
        ) : (
          <Table head={['Invoice', 'Patient', 'Issued', 'Total', 'Balance', 'Status', '']}>
            {invoices.data!.data.map((invoice) => (
              <tr key={invoice.id} className="hover:bg-slate-50">
                <td className="table-cell font-mono text-xs">{invoice.number}</td>
                <td className="table-cell">
                  <Link to={`/patients/${invoice.patient.id}`} className="font-medium text-brand-800 hover:underline">
                    {invoice.patient.firstName} {invoice.patient.lastName}
                  </Link>
                  <p className="font-mono text-xs text-slate-500">{invoice.patient.mrn}</p>
                </td>
                <td className="table-cell text-xs">{dateOnly(invoice.issuedAt)}</td>
                <td className="table-cell">{money(invoice.total)}</td>
                <td className="table-cell font-medium">{money(invoice.balance)}</td>
                <td className="table-cell">
                  <StatusBadge status={invoice.status} />
                </td>
                <td className="table-cell">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => openInvoice(invoice.id)}>
                      View
                    </Button>
                    {can('payment.record') && invoice.balance > 0 && (
                      <Button
                        size="sm"
                        onClick={() => {
                          setPaying(invoice);
                          setPayment({ amount: String(invoice.balance), method: 'MPESA', reference: '' });
                        }}
                      >
                        Pay
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal open={Boolean(paying)} onClose={() => setPaying(null)} title="Record a payment">
        <form className="space-y-3" onSubmit={recordPayment}>
          <p className="text-sm text-slate-600">
            {paying?.number} · balance <strong>{money(paying?.balance)}</strong>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Amount (KES)" htmlFor="p-amount" required>
              <Input id="p-amount" type="number" min="0.01" step="0.01" required value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} />
            </Field>
            <Field label="Method" htmlFor="p-method">
              <Select id="p-method" value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })}>
                {['MPESA', 'CASH', 'CARD', 'INSURANCE', 'BANK'].map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Reference / transaction code" htmlFor="p-ref">
            <Input id="p-ref" value={payment.reference} onChange={(e) => setPayment({ ...payment, reference: e.target.value })} placeholder="e.g. QK47HJ2L9P" />
          </Field>
          <Alert tone="info">A receipt number is generated automatically. Receipts can be downloaded as PDF.</Alert>
          <Button type="submit" loading={busy}>
            Record payment
          </Button>
        </form>
      </Modal>

      <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} title={`Invoice ${viewing?.number ?? ''}`} wide>
        {viewing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">
                  {viewing.patient.firstName} {viewing.patient.lastName}
                </p>
                <p className="text-xs text-slate-500">
                  {viewing.patient.mrn} · issued {dateTime(viewing.issuedAt)}
                </p>
              </div>
              <StatusBadge status={viewing.status} />
            </div>

            <Table head={['Description', 'Category', 'Qty', 'Unit', 'Amount']}>
              {viewing.items.map((item: any) => (
                <tr key={item.id}>
                  <td className="table-cell">{item.description}</td>
                  <td className="table-cell text-xs">{item.category}</td>
                  <td className="table-cell">{item.quantity}</td>
                  <td className="table-cell">{money(item.unitPrice)}</td>
                  <td className="table-cell">{money(item.amount)}</td>
                </tr>
              ))}
            </Table>

            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{money(viewing.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>Discount</span>
                <span>-{money(viewing.discount)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span>Total</span>
                <span>{money(viewing.total)}</span>
              </div>
              <div className="flex justify-between">
                <span>Paid</span>
                <span>{money(viewing.amountPaid)}</span>
              </div>
              <div className="flex justify-between text-rose-700">
                <span>Balance</span>
                <span>{money(viewing.balance)}</span>
              </div>
            </div>

            <div>
              <p className="mb-1 text-sm font-semibold">Payments</p>
              {viewing.payments.length === 0 ? (
                <p className="text-sm text-slate-500">No payments yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {viewing.payments.map((pay: any) => (
                    <li key={pay.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium">
                          {money(pay.amount)} · {pay.method}
                        </p>
                        <p className="text-xs text-slate-500">
                          {pay.receiptNo} · {dateTime(pay.paidAt)} · {pay.status}
                        </p>
                      </div>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => downloadFile(`/invoices/${viewing.id}/receipt`, `receipt-${pay.receiptNo}.pdf`)}>
                          Receipt PDF
                        </Button>
                        {can('payment.record') && pay.status === 'COMPLETED' && (
                          <Button size="sm" variant="ghost" onClick={() => refund(pay.id)}>
                            Refund
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
