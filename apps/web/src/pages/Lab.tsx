import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { dateTime, money } from '../lib/format';
import {
  Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Select, StatusBadge, Table, Tabs, Textarea, useToast,
} from '../components/ui';

export default function Lab() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'worklist';
  return (
    <div>
      <PageHeader title="Laboratory" description="Sample collection, result entry and test catalog." />
      <Tabs
        value={tab}
        onChange={(next) => setParams(next === 'worklist' ? {} : { tab: next })}
        tabs={[
          { id: 'worklist', label: 'Worklist' },
          { id: 'catalog', label: 'Test catalog' },
        ]}
      />
      <div className="mt-3">{tab === 'worklist' ? <Worklist /> : <Catalog />}</div>
    </div>
  );
}

function Worklist() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('ORDERED');
  const [selected, setSelected] = useState<any | null>(null);
  const [result, setResult] = useState({ resultValue: '', unit: '', referenceRange: '', flag: 'NORMAL', interpretation: '' });
  const [busy, setBusy] = useState(false);

  const orders = useQuery({
    queryKey: ['lab-orders', status],
    queryFn: () => api.get<{ data: any[] }>('/lab-orders', { status, pageSize: 100 }),
    refetchInterval: 20_000,
  });

  async function collect(id: string) {
    try {
      await api.post(`/lab-orders/${id}/collect`);
      toast.push('Sample collected', 'success');
      orders.refetch();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not update', 'danger');
    }
  }

  async function submitResult(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      await api.post(`/lab-orders/${selected.id}/result`, result);
      toast.push('Result saved and the doctor notified', 'success');
      setSelected(null);
      setResult({ resultValue: '', unit: '', referenceRange: '', flag: 'NORMAL', interpretation: '' });
      orders.refetch();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not save the result', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Laboratory worklist"
        subtitle="Orders appear as soon as clinicians request them"
        actions={
          <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status">
            {['ORDERED', 'SAMPLE_COLLECTED', 'COMPLETED', 'CANCELLED'].map((option) => (
              <option key={option} value={option}>
                {option.toLowerCase().replace('_', ' ')}
              </option>
            ))}
          </Select>
        }
      />
      {orders.isLoading ? (
        <Loading />
      ) : (orders.data?.data ?? []).length === 0 ? (
        <EmptyState title="No orders in this state" />
      ) : (
        <Table head={['Patient', 'Test', 'Priority', 'Ordered', 'Status', '']}>
          {orders.data!.data.map((order) => (
            <tr key={order.id}>
              <td className="table-cell">
                <p className="font-medium">
                  {order.patient.firstName} {order.patient.lastName}
                </p>
                <p className="font-mono text-xs text-slate-500">
                  {order.patient.mrn} · {order.patient.sex} 
                </p>
              </td>
              <td className="table-cell">
                <p>{order.test.name}</p>
                <p className="text-xs text-slate-500">{order.test.sampleType}</p>
              </td>
              <td className="table-cell">
                <StatusBadge status={order.priority} />
              </td>
              <td className="table-cell text-xs">{dateTime(order.orderedAt)}</td>
              <td className="table-cell">
                <StatusBadge status={order.status} />
                {order.result && <p className="mt-1 text-xs font-medium">{order.result.resultValue} {order.result.unit}</p>}
              </td>
              <td className="table-cell">
                <div className="flex flex-wrap gap-1.5">
                  {order.status === 'ORDERED' && (
                    <Button size="sm" variant="outline" onClick={() => collect(order.id)}>
                      Collect sample
                    </Button>
                  )}
                  {['ORDERED', 'SAMPLE_COLLECTED'].includes(order.status) && (
                    <Button size="sm" onClick={() => setSelected(order)}>
                      Enter result
                    </Button>
                  )}
                  <Link to={`/patients/${order.patient.id}`} className="text-xs font-medium text-brand-700 hover:underline">
                    Record
                  </Link>
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title="Enter laboratory result">
        <form className="space-y-3" onSubmit={submitResult}>
          <p className="text-sm text-slate-600">
            {selected?.test?.name} for {selected?.patient?.firstName} {selected?.patient?.lastName}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Result value" htmlFor="res-val" required>
              <Input id="res-val" required value={result.resultValue} onChange={(e) => setResult({ ...result, resultValue: e.target.value })} />
            </Field>
            <Field label="Unit" htmlFor="res-unit">
              <Input id="res-unit" value={result.unit} onChange={(e) => setResult({ ...result, unit: e.target.value })} placeholder="g/dL" />
            </Field>
            <Field label="Reference range" htmlFor="res-range">
              <Input id="res-range" value={result.referenceRange} onChange={(e) => setResult({ ...result, referenceRange: e.target.value })} placeholder="4.0 - 5.6" />
            </Field>
            <Field label="Flag" htmlFor="res-flag">
              <Select id="res-flag" value={result.flag} onChange={(e) => setResult({ ...result, flag: e.target.value })}>
                {['NORMAL', 'HIGH', 'LOW', 'CRITICAL'].map((flag) => (
                  <option key={flag} value={flag}>
                    {flag}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Interpretation" htmlFor="res-interp">
            <Textarea id="res-interp" value={result.interpretation} onChange={(e) => setResult({ ...result, interpretation: e.target.value })} />
          </Field>
          {result.flag === 'CRITICAL' && <Alert tone="danger">Critical results should also be phoned to the ordering clinician.</Alert>}
          <Button type="submit" loading={busy}>
            Save result & notify
          </Button>
        </form>
      </Modal>
    </Card>
  );
}

function Catalog() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', price: '', sampleType: 'BLOOD', turnaroundHours: '24' });
  const tests = useQuery({
    queryKey: ['lab-tests', 'all'],
    queryFn: () => api.get<{ data: any[] }>('/lab-tests'),
  });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.post('/lab-tests', {
        ...form,
        price: Number(form.price),
        turnaroundHours: Number(form.turnaroundHours),
      });
      toast.push('Test added', 'success');
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ['lab-tests'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not add the test', 'danger');
    }
  }

  return (
    <Card>
      <CardHeader
        title="Test catalog"
        subtitle="Prices are charged to the patient's invoice when a test is ordered"
        actions={<Button size="sm" onClick={() => setOpen(true)}>Add test</Button>}
      />
      {tests.isLoading ? (
        <Loading />
      ) : (
        <Table head={['Code', 'Test', 'Sample', 'Turnaround', 'Price']}>
          {(tests.data?.data ?? []).map((test) => (
            <tr key={test.id}>
              <td className="table-cell font-mono text-xs">{test.code}</td>
              <td className="table-cell font-medium">{test.name}</td>
              <td className="table-cell">{test.sampleType}</td>
              <td className="table-cell">
                <Badge tone="neutral">{test.turnaroundHours}h</Badge>
              </td>
              <td className="table-cell">{money(test.price)}</td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Add laboratory test">
        <form className="space-y-3" onSubmit={create}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Code" htmlFor="t-code" required>
              <Input id="t-code" required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </Field>
            <Field label="Name" htmlFor="t-name" required>
              <Input id="t-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Price (KES)" htmlFor="t-price" required>
              <Input id="t-price" type="number" min="0" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            </Field>
            <Field label="Sample type" htmlFor="t-sample">
              <Select id="t-sample" value={form.sampleType} onChange={(e) => setForm({ ...form, sampleType: e.target.value })}>
                {['BLOOD', 'URINE', 'STOOL', 'SWAB', 'TISSUE', 'OTHER'].map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit">Save test</Button>
        </form>
      </Modal>
    </Card>
  );
}
