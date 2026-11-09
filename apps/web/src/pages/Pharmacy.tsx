import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { dateOnly, dateTime, money } from '../lib/format';
import { useDrugs } from '../lib/hooks';
import {
  Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader,
  StatusBadge, Table, Tabs, useToast,
} from '../components/ui';

export default function Pharmacy() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'prescriptions';
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dispensing, setDispensing] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const prescriptions = useQuery({
    queryKey: ['pharmacy-prescriptions'],
    queryFn: () => api.get<{ data: any[] }>('/prescriptions', { status: 'PENDING', pageSize: 50 }),
    enabled: tab === 'prescriptions',
    refetchInterval: 30_000,
  });

  async function dispense() {
    if (!dispensing) return;
    setBusy(true);
    try {
      const res = await api.post<any>(`/prescriptions/${dispensing.id}/dispense`, {});
      toast.push('Dispensed. Stock updated and the bill was charged.', 'success');
      setDispensing(null);
      queryClient.invalidateQueries({ queryKey: ['pharmacy-prescriptions'] });
      queryClient.invalidateQueries({ queryKey: ['stock-alerts'] });
      void res;
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not dispense', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Pharmacy"
        description="Dispense prescriptions, manage batches and keep stock safe."
        actions={
          <Button variant="outline" onClick={() => { prescriptions.refetch(); }}>
            Refresh queue
          </Button>
        }
      />
      <Tabs
        value={tab}
        onChange={(next) => setParams(next === 'prescriptions' ? {} : { tab: next })}
        tabs={[
          { id: 'prescriptions', label: 'Prescription queue', count: prescriptions.data?.data.length },
          { id: 'stock', label: 'Stock alerts' },
          { id: 'catalog', label: 'Medicine catalog' },
        ]}
      />

      <div className="mt-3">
        {tab === 'prescriptions' && (
          <Card>
            <CardHeader title="Pending prescriptions" subtitle="Oldest first. Stock decrements on dispense (first-expiry-first-out)." />
            {prescriptions.isLoading ? (
              <Loading />
            ) : (prescriptions.data?.data ?? []).length === 0 ? (
              <EmptyState title="No prescriptions waiting" description="New prescriptions from doctors appear here automatically." />
            ) : (
              <ul className="divide-y divide-slate-100">
                {prescriptions.data!.data.map((script) => (
                  <li key={script.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-slate-900">
                          {script.patient.firstName} {script.patient.lastName}
                          <span className="ml-2 font-mono text-xs text-slate-500">{script.patient.mrn}</span>
                        </p>
                        <p className="text-xs text-slate-500">
                          {dateTime(script.createdAt)} · Dr {script.doctor.firstName} {script.doctor.lastName}
                        </p>
                        {script.patient.allergies && (
                          <p className="mt-1 text-xs font-medium text-rose-600">Allergy: {script.patient.allergies}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={script.status} />
                        <Button size="sm" onClick={() => setDispensing(script)}>
                          Dispense
                        </Button>
                      </div>
                    </div>
                    <ul className="mt-2 space-y-1 text-xs text-slate-700">
                      {script.items.map((item: any) => (
                        <li key={item.id} className="flex justify-between gap-2 rounded bg-slate-50 px-2 py-1">
                          <span>
                            {item.drug.name} {item.drug.strength} — {item.dose}, {item.frequency} for {item.durationDays} days
                          </span>
                          <span className="font-medium">×{item.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {tab === 'stock' && <StockAlerts />}
        {tab === 'catalog' && <Catalog />}
      </div>

      <Modal
        open={Boolean(dispensing)}
        onClose={() => setDispensing(null)}
        title="Confirm dispensing"
        footer={
          <>
            <Button variant="outline" onClick={() => setDispensing(null)}>
              Cancel
            </Button>
            <Button onClick={dispense} loading={busy}>
              Dispense all items
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Dispensing <strong>{dispensing?.items?.length ?? 0}</strong> item(s) for{' '}
          <strong>
            {dispensing?.patient?.firstName} {dispensing?.patient?.lastName}
          </strong>
          . Stock is deducted from the earliest-expiring batches and the patient's invoice is updated.
        </p>
        <ul className="mt-3 space-y-1 text-sm">
          {dispensing?.items?.map((item: any) => (
            <li key={item.id} className="flex justify-between">
              <span>
                {item.drug.name} {item.drug.strength}
              </span>
              <span className="font-medium">×{item.quantity}</span>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

function StockAlerts() {
  const { data, isLoading } = useQuery({
    queryKey: ['stock-alerts'],
    queryFn: () => api.get<any>('/stock/alerts'),
  });
  if (isLoading) return <Loading />;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader title="Low stock" subtitle={`${data?.counts?.lowStock ?? 0} items at or below reorder level`} />
        {(data?.lowStock ?? []).length === 0 ? (
          <EmptyState title="Stock levels healthy" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.lowStock.map((drug: any) => (
              <li key={drug.id} className="flex items-center justify-between px-4 py-2">
                <span>
                  {drug.name} {drug.strength}
                </span>
                <Badge tone="danger">
                  {drug.stockOnHand} / {drug.reorderLevel}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Expiring within 60 days" />
        {(data?.expiringSoon ?? []).length === 0 ? (
          <EmptyState title="Nothing expiring soon" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.expiringSoon.map((batch: any) => (
              <li key={batch.id} className="px-4 py-2">
                <div className="flex items-center justify-between">
                  <span>
                    {batch.drug.name} · {batch.batchNo}
                  </span>
                  <Badge tone="warning">{dateOnly(batch.expiryDate)}</Badge>
                </div>
                <p className="text-xs text-slate-500">{batch.quantity} units remaining</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Expired stock" subtitle="Quarantine and write off" />
        {(data?.expired ?? []).length === 0 ? (
          <EmptyState title="No expired batches" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.expired.map((batch: any) => (
              <li key={batch.id} className="px-4 py-2">
                <div className="flex items-center justify-between">
                  <span>
                    {batch.drug.name} · {batch.batchNo}
                  </span>
                  <Badge tone="danger">{dateOnly(batch.expiryDate)}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Catalog() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const drugs = useDrugs();
  const [receiveFor, setReceiveFor] = useState<any | null>(null);
  const [newDrug, setNewDrug] = useState(false);
  const [batch, setBatch] = useState({ batchNo: '', expiryDate: '', quantity: '', unitCost: '' });
  const [drugForm, setDrugForm] = useState({ name: '', genericName: '', strength: '', unitPrice: '', reorderLevel: '20', form: 'TABLET' });

  async function receive(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.post(`/drugs/${receiveFor.id}/batches`, {
        batchNo: batch.batchNo,
        expiryDate: batch.expiryDate,
        quantity: Number(batch.quantity),
        unitCost: Number(batch.unitCost || 0),
      });
      toast.push('Stock received', 'success');
      setReceiveFor(null);
      setBatch({ batchNo: '', expiryDate: '', quantity: '', unitCost: '' });
      queryClient.invalidateQueries({ queryKey: ['drugs'] });
      queryClient.invalidateQueries({ queryKey: ['stock-alerts'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not receive stock', 'danger');
    }
  }

  async function createDrug(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.post('/drugs', {
        ...drugForm,
        unitPrice: Number(drugForm.unitPrice),
        reorderLevel: Number(drugForm.reorderLevel),
      });
      toast.push('Medicine added to the catalog', 'success');
      setNewDrug(false);
      queryClient.invalidateQueries({ queryKey: ['drugs'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not add medicine', 'danger');
    }
  }

  return (
    <Card>
      <CardHeader
        title="Medicine catalog"
        subtitle="Unit prices drive automatic billing"
        actions={<Button size="sm" onClick={() => setNewDrug(true)}>Add medicine</Button>}
      />
      {drugs.isLoading ? (
        <Loading />
      ) : (
        <Table head={['Medicine', 'Form', 'Unit price', 'Stock', 'Reorder level', '']}>
          {(drugs.data?.data ?? []).map((drug) => (
            <tr key={drug.id}>
              <td className="table-cell">
                <p className="font-medium">{drug.name} {drug.strength}</p>
                <p className="text-xs text-slate-500">{drug.genericName}</p>
              </td>
              <td className="table-cell text-xs">{drug.form}</td>
              <td className="table-cell">{money(drug.unitPrice)}</td>
              <td className="table-cell">
                <Badge tone={drug.stockOnHand === 0 ? 'danger' : drug.lowStock ? 'warning' : 'success'}>{drug.stockOnHand}</Badge>
              </td>
              <td className="table-cell">{drug.reorderLevel}</td>
              <td className="table-cell text-right">
                <Button size="sm" variant="outline" onClick={() => setReceiveFor(drug)}>
                  Receive stock
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal open={Boolean(receiveFor)} onClose={() => setReceiveFor(null)} title={`Receive stock · ${receiveFor?.name ?? ''}`}>
        <form className="space-y-3" onSubmit={receive}>
          <Field label="Batch number" htmlFor="batch-no" required>
            <Input id="batch-no" required value={batch.batchNo} onChange={(e) => setBatch({ ...batch, batchNo: e.target.value })} />
          </Field>
          <Field label="Expiry date" htmlFor="batch-exp" required>
            <Input id="batch-exp" type="date" required value={batch.expiryDate} onChange={(e) => setBatch({ ...batch, expiryDate: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Quantity" htmlFor="batch-qty" required>
              <Input id="batch-qty" type="number" min="1" required value={batch.quantity} onChange={(e) => setBatch({ ...batch, quantity: e.target.value })} />
            </Field>
            <Field label="Unit cost (KES)" htmlFor="batch-cost">
              <Input id="batch-cost" type="number" min="0" step="0.01" value={batch.unitCost} onChange={(e) => setBatch({ ...batch, unitCost: e.target.value })} />
            </Field>
          </div>
          <Button type="submit">Receive batch</Button>
        </form>
      </Modal>

      <Modal open={newDrug} onClose={() => setNewDrug(false)} title="Add medicine">
        <form className="space-y-3" onSubmit={createDrug}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name" htmlFor="d-name" required>
              <Input id="d-name" required value={drugForm.name} onChange={(e) => setDrugForm({ ...drugForm, name: e.target.value })} />
            </Field>
            <Field label="Generic name" htmlFor="d-generic">
              <Input id="d-generic" value={drugForm.genericName} onChange={(e) => setDrugForm({ ...drugForm, genericName: e.target.value })} />
            </Field>
            <Field label="Strength" htmlFor="d-strength">
              <Input id="d-strength" value={drugForm.strength} onChange={(e) => setDrugForm({ ...drugForm, strength: e.target.value })} placeholder="500mg" />
            </Field>
            <Field label="Form" htmlFor="d-form">
              <select id="d-form" className="input" value={drugForm.form} onChange={(e) => setDrugForm({ ...drugForm, form: e.target.value })}>
                {['TABLET', 'CAPSULE', 'SYRUP', 'INJECTION', 'CREAM', 'DROPS', 'INHALER', 'SACHET'].map((form) => (
                  <option key={form} value={form}>
                    {form}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Unit price (KES)" htmlFor="d-price" required>
              <Input id="d-price" type="number" min="0" step="0.01" required value={drugForm.unitPrice} onChange={(e) => setDrugForm({ ...drugForm, unitPrice: e.target.value })} />
            </Field>
            <Field label="Reorder level" htmlFor="d-reorder">
              <Input id="d-reorder" type="number" min="0" value={drugForm.reorderLevel} onChange={(e) => setDrugForm({ ...drugForm, reorderLevel: e.target.value })} />
            </Field>
          </div>
          <Alert tone="info">Receive a stock batch after adding the medicine so it can be prescribed.</Alert>
          <Button type="submit">Save medicine</Button>
        </form>
      </Modal>
    </Card>
  );
}
