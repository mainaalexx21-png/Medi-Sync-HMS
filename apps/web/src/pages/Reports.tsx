import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, todayInput } from '../lib/format';
import { Button, Card, CardHeader, EmptyState, Field, Input, Loading, PageHeader, Stat, Table } from '../components/ui';

function monthAgo() {
  const date = new Date();
  date.setMonth(date.getMonth() - 1);
  return date.toISOString().slice(0, 10);
}

export default function Reports() {
  const { can } = useAuth();
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(todayInput());

  const overview = useQuery({
    queryKey: ['reports', 'overview', from, to],
    queryFn: () => api.get<any>('/reports/overview', { from, to }),
  });
  const waits = useQuery({
    queryKey: ['reports', 'wait-times', from, to],
    queryFn: () => api.get<any>('/reports/wait-times', { from, to }),
  });
  const revenue = useQuery({
    queryKey: ['reports', 'revenue', from, to],
    queryFn: () => api.get<any>('/reports/revenue', { from, to }),
    enabled: can('report.financial'),
  });
  const doctorUtil = useQuery({
    queryKey: ['reports', 'appointments', from, to],
    queryFn: () => api.get<any>('/reports/appointments', { from, to }),
  });

  const data = overview.data;
  const maxMethod = Math.max(1, ...(revenue.data?.byMethod ?? []).map((row: any) => row.amount));

  return (
    <div>
      <PageHeader
        title="Reports & dashboards"
        description="Operational and financial insight from live hospital data. Exports are audit-logged."
        actions={
          <>
            <Button variant="outline" onClick={() => downloadFile(`/reports/export?type=overview&format=csv&from=${from}&to=${to}`, 'medisync-overview.csv')}>
              Export CSV
            </Button>
            <Button variant="outline" onClick={() => downloadFile(`/reports/export?type=wait-times&format=pdf&from=${from}&to=${to}`, 'medisync-waits.pdf')}>
              Export PDF
            </Button>
          </>
        }
      />

      <Card className="mb-4">
        <div className="grid gap-2 p-3 sm:grid-cols-3">
          <Field label="From" htmlFor="r-from">
            <Input id="r-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="To" htmlFor="r-to">
            <Input id="r-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button variant="outline" onClick={() => overview.refetch()} loading={overview.isFetching}>
              Apply
            </Button>
          </div>
        </div>
      </Card>

      {overview.isLoading || !data ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="New patients" value={data.patients.new} tone="brand" />
            <Stat label="Appointments" value={data.appointments.total} hint={`${data.appointments.noShowRate}% no-show`} />
            <Stat
              label="Average wait"
              value={`${data.queue.avgWaitMinutes} min`}
              hint={`${data.queue.avgConsultMinutes} min average consult`}
              tone={data.queue.avgWaitMinutes > 30 ? 'warning' : 'success'}
            />
            <Stat
              label="Outstanding"
              value={money(data.revenue.outstanding)}
              hint={`${data.revenue.unpaidInvoices} unpaid invoices`}
              tone={data.revenue.outstanding > 0 ? 'danger' : 'neutral'}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Revenue by payment method" subtitle={`Collected ${money(data.revenue.collected)} in this period`} />
              {!can('report.financial') ? (
                <EmptyState title="Restricted" description="Financial breakdown is available to finance and management roles." />
              ) : revenue.isLoading ? (
                <Loading />
              ) : (revenue.data?.byMethod ?? []).length === 0 ? (
                <EmptyState title="No payments in this period" />
              ) : (
                <div className="space-y-3 p-4">
                  {revenue.data.byMethod.map((row: any) => (
                    <div key={row.method}>
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="font-medium text-slate-700">{row.method}</span>
                        <span className="text-slate-600">{money(row.amount)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100">
                        <div className="h-2 rounded-full bg-brand-600" style={{ width: `${(row.amount / maxMethod) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="Average wait by department" subtitle="Check-in to consultation start" />
              {waits.isLoading ? (
                <Loading />
              ) : (
                <Table head={['Department', 'Visits', 'Avg wait', 'Max wait']}>
                  {(waits.data?.data ?? []).map((row: any) => (
                    <tr key={row.departmentId}>
                      <td className="table-cell font-medium">{row.department}</td>
                      <td className="table-cell">{row.completed}</td>
                      <td className="table-cell">
                        <span className={row.avgWaitMinutes > 30 ? 'font-semibold text-amber-700' : 'text-slate-700'}>{row.avgWaitMinutes} min</span>
                      </td>
                      <td className="table-cell text-slate-500">{row.maxWaitMinutes} min</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card>
              <CardHeader title="Doctor utilisation" subtitle="Completed appointments / bookings" />
              {doctorUtil.isLoading ? (
                <Loading />
              ) : (
                <Table head={['Doctor', 'Booked', 'Completed', 'No-shows', 'Utilisation']}>
                  {(doctorUtil.data?.data ?? []).map((row: any) => (
                    <tr key={row.doctor}>
                      <td className="table-cell font-medium">{row.doctor}</td>
                      <td className="table-cell">{row.total}</td>
                      <td className="table-cell">{row.completed}</td>
                      <td className="table-cell">{row.noShow}</td>
                      <td className="table-cell">{row.utilisation}%</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>

            <Card>
              <CardHeader title="Stock health" subtitle="From the pharmacy inventory" />
              <div className="grid grid-cols-3 gap-2 p-4 text-center">
                <div>
                  <p className="text-2xl font-semibold text-slate-900">{data.stock.catalogSize}</p>
                  <p className="text-xs text-slate-500">Medicines</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold text-amber-700">{data.stock.lowStock}</p>
                  <p className="text-xs text-slate-500">Low stock</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold text-brand-700">{data.stock.expiringSoon}</p>
                  <p className="text-xs text-slate-500">Expiring (60d)</p>
                </div>
              </div>
              <div className="border-t border-slate-100 p-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadFile(`/reports/export?type=stock&format=csv&from=${from}&to=${to}`, 'medisync-stock.csv')}
                >
                  Export stock CSV
                </Button>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
