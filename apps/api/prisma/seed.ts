/**
 * Seed data for MEDI SYNC.
 *
 * Demo accounts (all share the same password, MFA secret in dev). One account
 * per job title, five staff roles:
 *   FRONT_DESK    reception@medisync.test (front desk), records@medisync.test (records)
 *   CLINICAL      doctor.amina@medisync.test (doctor), doctor.brian@medisync.test (doctor),
 *                 nurse@medisync.test (nurse)
 *   DIAGNOSTICS   lab@medisync.test (lab), radiology@medisync.test (imaging),
 *                 pharmacist@medisync.test (pharmacy)
 *   FINANCE       billing@medisync.test (billing), hr@medisync.test (staff & rosters)
 *   SYSTEM_ADMIN  admin.it@medisync.test (no clinical access by design)
 *   External      auditor@medisync.test (de-identified only, expiring grant),
 *                 vendor@medisync.test  (scoped, expiring grant)
 *   Portal        grace@example.test (no MFA yet - demonstrates enrolment),
 *                 peter@example.test, guardian@example.test (consented scopes on Grace)
 *
 * Password: MediSync#2026   MFA secret (TOTP): JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'MediSync#2026';
export const DEMO_TOTP_SECRET = process.env.SEED_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Field encryption matching src/lib/crypto.ts (kept local so seeding needs no app boot). */
function encryptionKey(): Buffer {
  const raw = process.env.FIELD_ENCRYPTION_KEY ?? '';
  const base64 = Buffer.from(raw, 'base64');
  if (base64.length === 32) return base64;
  return crypto.createHash('sha256').update(raw || 'dev-field-key').digest();
}

function encryptField(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function hmac(value: string) {
  const pepper = process.env.REFRESH_TOKEN_PEPPER ?? 'dev-pepper';
  return crypto.createHmac('sha256', pepper).update(value.trim().toLowerCase()).digest('hex');
}

function at(day: Date, hours: number, minutes = 0) {
  const d = new Date(day);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function todayAt(hours: number, minutes = 0) {
  return at(new Date(), hours, minutes);
}

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 24 * 3600_000);
}

async function main() {
  const existing = await prisma.user.count();
  if (existing > 0) {
    console.log('Database already seeded - run `npm run db:reset` to start over.');
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const mfaSecretEnc = encryptField(DEMO_TOTP_SECRET);

  // -------------------------------------------------------------------------
  // Departments
  // -------------------------------------------------------------------------
  const [general, pediatrics, pharmacyDept, labDept, adminDept] = await Promise.all([
    prisma.department.create({ data: { name: 'General Medicine', code: 'GEN' } }),
    prisma.department.create({ data: { name: 'Pediatrics', code: 'PED' } }),
    prisma.department.create({ data: { name: 'Pharmacy', code: 'PHA', type: 'PHARMACY' } }),
    prisma.department.create({ data: { name: 'Laboratory & Imaging', code: 'LAB', type: 'LAB' } }),
    prisma.department.create({ data: { name: 'Administration', code: 'ADM', type: 'ADMIN' } }),
  ]);

  // -------------------------------------------------------------------------
  // Staff accounts
  // -------------------------------------------------------------------------
  type StaffSpec = {
    email: string; role: string; clinicalRole?: string; first: string; last: string; job: string;
    dept?: string; mfa?: boolean; license?: string;
  };

  // Five roles, one account per job title. clinicalRole only applies to CLINICAL.
  const staffSpecs: StaffSpec[] = [
    { email: 'doctor.amina@medisync.test', role: 'CLINICAL', clinicalRole: 'DOCTOR', first: 'Amina', last: 'Odhiambo', job: 'Consultant Physician', dept: general.id, mfa: true, license: 'KMPDC-11284' },
    { email: 'doctor.brian@medisync.test', role: 'CLINICAL', clinicalRole: 'DOCTOR', first: 'Brian', last: 'Kiptoo', job: 'Paediatrician', dept: pediatrics.id, mfa: true, license: 'KMPDC-20411' },
    { email: 'nurse@medisync.test', role: 'CLINICAL', clinicalRole: 'NURSE', first: 'Faith', last: 'Chebet', job: 'Ward Nurse', dept: general.id, mfa: true },
    { email: 'pharmacist@medisync.test', role: 'DIAGNOSTICS', first: 'Kevin', last: 'Mwangi', job: 'Pharmacist', dept: pharmacyDept.id, mfa: true },
    { email: 'lab@medisync.test', role: 'DIAGNOSTICS', first: 'Diana', last: 'Anyango', job: 'Lab Technologist', dept: labDept.id, mfa: true },
    { email: 'radiology@medisync.test', role: 'DIAGNOSTICS', first: 'Otieno', last: 'Wafula', job: 'Radiographer', dept: labDept.id, mfa: true },
    { email: 'reception@medisync.test', role: 'FRONT_DESK', first: 'Joy', last: 'Wambui', job: 'Front Desk Officer', dept: adminDept.id, mfa: true },
    { email: 'records@medisync.test', role: 'FRONT_DESK', first: 'Naomi', last: 'Kilonzo', job: 'Records Officer', dept: adminDept.id, mfa: true },
    { email: 'billing@medisync.test', role: 'FINANCE', first: 'Samuel', last: 'Ochieng', job: 'Billing Officer', dept: adminDept.id, mfa: true },
    { email: 'hr@medisync.test', role: 'FINANCE', first: 'Charles', last: 'Barasa', job: 'HR & Rota Manager', dept: adminDept.id, mfa: true },
    { email: 'admin.it@medisync.test', role: 'SYSTEM_ADMIN', first: 'Lydia', last: 'Njoroge', job: 'System Administrator', dept: adminDept.id, mfa: true },
  ];

  const staffByEmail: Record<string, { staffId: string; userId: string }> = {};

  for (const [index, spec] of staffSpecs.entries()) {
    const user = await prisma.user.create({
      data: {
        email: spec.email,
        passwordHash,
        role: spec.role,
        mfaEnabled: spec.mfa ?? false,
        mfaSecretEnc: spec.mfa ? mfaSecretEnc : null,
        mfaEnrolledAt: spec.mfa ? new Date() : null,
        staff: {
          create: {
            employeeNo: `EMP-${1000 + index}`,
            firstName: spec.first,
            lastName: spec.last,
            jobTitle: spec.job,
            clinicalRole: spec.clinicalRole ?? null,
            departmentId: spec.dept ?? null,
            licenseNo: spec.license ?? null,
            phone: '+254700000' + String(100 + index),
          },
        },
      },
      include: { staff: true },
    });
    staffByEmail[spec.email] = { staffId: user.staff!.id, userId: user.id };
  }

  const doctorAmina = staffByEmail['doctor.amina@medisync.test'];
  const doctorBrian = staffByEmail['doctor.brian@medisync.test'];
  const pharmacist = staffByEmail['pharmacist@medisync.test'];
  const labTech = staffByEmail['lab@medisync.test'];
  const reception = staffByEmail['reception@medisync.test'];
  const billing = staffByEmail['billing@medisync.test'];

  // External, time-limited accounts
  for (const spec of [
    { email: 'auditor@medisync.test', role: 'AUDITOR', scope: 'audit.read,deidentified.read,report.read' },
    { email: 'vendor@medisync.test', role: 'VENDOR', scope: 'patient.read,lab.read' },
  ]) {
    const user = await prisma.user.create({
      data: {
        email: spec.email,
        passwordHash,
        role: spec.role,
        mfaEnabled: true,
        mfaSecretEnc,
        mfaEnrolledAt: new Date(),
      },
    });
    await prisma.externalAccessGrant.create({
      data: {
        userId: user.id,
        type: spec.role,
        scope: spec.scope,
        reason: spec.role === 'AUDITOR' ? 'Annual KDPA compliance audit' : 'Laboratory analyser integration support',
        expiresAt: daysFromNow(spec.role === 'AUDITOR' ? 14 : 3),
        createdById: staffByEmail['admin.it@medisync.test'].userId,
      },
    });
  }

  // Recovery codes for each MFA-enabled user (demo code documented in README)
  const demoRecovery = 'DEMO-CODE-0001';
  const mfaUsers = await prisma.user.findMany({ where: { mfaEnabled: true }, select: { id: true } });
  for (const user of mfaUsers) {
    await prisma.recoveryCode.create({
      data: { userId: user.id, codeHash: crypto.createHash('sha256').update(demoRecovery.replace(/-/g, '')).digest('hex') },
    });
  }

  // -------------------------------------------------------------------------
  // Doctors' weekly rotas
  // -------------------------------------------------------------------------
  for (const doctor of [doctorAmina, doctorBrian]) {
    for (let weekday = 1; weekday <= 5; weekday += 1) {
      await prisma.doctorSchedule.create({
        data: {
          staffId: doctor.staffId,
          departmentId: doctor === doctorAmina ? general.id : pediatrics.id,
          weekday,
          startTime: '08:00',
          endTime: '16:00',
          slotMinutes: 20,
          room: doctor === doctorAmina ? 'Room 4' : 'Room 7',
        },
      });
    }
  }
  await prisma.doctorSchedule.create({
    data: { staffId: doctorAmina.staffId, departmentId: general.id, weekday: 6, startTime: '09:00', endTime: '13:00', slotMinutes: 20, room: 'Room 4' },
  });

  // -------------------------------------------------------------------------
  // Patients
  // -------------------------------------------------------------------------
  const graceUser = await prisma.user.create({
    data: { email: 'grace@example.test', passwordHash, role: 'PATIENT' },
  });
  const peterUser = await prisma.user.create({
    data: { email: 'peter@example.test', passwordHash, role: 'PATIENT' },
  });
  const guardianUser = await prisma.user.create({
    data: { email: 'guardian@example.test', passwordHash, role: 'GUARDIAN', mfaEnabled: true, mfaSecretEnc, mfaEnrolledAt: new Date() },
  });

  const grace = await prisma.patient.create({
    data: {
      mrn: 'MS-01001',
      firstName: 'Grace',
      lastName: 'Wanjiku',
      dateOfBirth: new Date('1992-04-18'),
      sex: 'FEMALE',
      phone: '+254712345678',
      email: 'grace@example.test',
      address: '12 Ngong Road',
      county: 'Nairobi',
      nationalIdEnc: encryptField('29876543'),
      nationalIdHash: hmac('29876543'),
      bloodGroup: 'O+',
      allergies: 'Penicillin - rash',
      chronicConditions: 'Type 2 diabetes (diagnosed 2021)',
      emergencyContactName: 'James Wanjiku',
      emergencyContactPhone: '+254798765432',
      userId: graceUser.id,
      createdById: reception.userId,
    },
  });

  const peter = await prisma.patient.create({
    data: {
      mrn: 'MS-01002',
      firstName: 'Peter',
      lastName: 'Otieno',
      dateOfBirth: new Date('1985-11-02'),
      sex: 'MALE',
      phone: '+254723456789',
      email: 'peter@example.test',
      county: 'Kisumu',
      bloodGroup: 'A+',
      userId: peterUser.id,
      createdById: reception.userId,
    },
  });

  const amina = await prisma.patient.create({
    data: {
      mrn: 'MS-01003',
      firstName: 'Amina',
      lastName: 'Hassan',
      dateOfBirth: new Date('2019-02-11'),
      sex: 'FEMALE',
      phone: '+254734567890',
      county: 'Mombasa',
      allergies: 'None known',
      createdById: reception.userId,
    },
  });

  const john = await prisma.patient.create({
    data: {
      mrn: 'MS-01004',
      firstName: 'John',
      lastName: 'Kamau',
      dateOfBirth: new Date('1958-07-23'),
      sex: 'MALE',
      phone: '+254745678901',
      county: 'Nairobi',
      chronicConditions: 'Hypertension',
      createdById: reception.userId,
    },
  });

  await prisma.patient.create({
    data: {
      mrn: 'MS-01005',
      firstName: 'Mary',
      lastName: 'Njeri',
      dateOfBirth: new Date('1998-09-30'),
      sex: 'FEMALE',
      phone: '+254756789012',
      county: 'Nakuru',
      createdById: reception.userId,
    },
  });

  for (const patient of [grace, peter, amina, john]) {
    await prisma.patientVersion.create({
      data: {
        patientId: patient.id, version: 1, editedById: reception.userId,
        reason: 'Initial registration', snapshot: JSON.stringify({ mrn: patient.mrn, source: 'seed' }),
      },
    });
  }

  // Guardian consent: appointments + bills only (no clinical notes or results)
  await prisma.guardianLink.create({
    data: {
      patientId: grace.id,
      guardianUserId: guardianUser.id,
      relationship: 'Spouse',
      status: 'ACTIVE',
      scopes: 'appointments,bills,demographics',
      consentedAt: new Date(),
      createdById: reception.userId,
    },
  });

  // -------------------------------------------------------------------------
  // Pharmacy catalog + stock
  // -------------------------------------------------------------------------
  const drugSpecs = [
    { name: 'Paracetamol', generic: 'Acetaminophen', form: 'TABLET', strength: '500mg', price: 5, reorder: 100, qty: 1200, expiry: 400 },
    { name: 'Amoxicillin', generic: 'Amoxicillin', form: 'CAPSULE', strength: '250mg', price: 12, reorder: 100, qty: 600, expiry: 300 },
    { name: 'Artemether/Lumefantrine', generic: 'Coartem', form: 'TABLET', strength: '20/120mg', price: 30, reorder: 60, qty: 240, expiry: 200 },
    { name: 'Metformin', generic: 'Metformin HCl', form: 'TABLET', strength: '500mg', price: 8, reorder: 80, qty: 500, expiry: 365 },
    { name: 'Salbutamol inhaler', generic: 'Salbutamol', form: 'INHALER', strength: '100mcg', price: 850, reorder: 10, qty: 18, expiry: 240 },
    { name: 'ORS sachet', generic: 'Oral rehydration salts', form: 'SACHET', strength: '20.5g', price: 30, reorder: 50, qty: 40, expiry: 500 },
    { name: 'Ceftriaxone', generic: 'Ceftriaxone sodium', form: 'INJECTION', strength: '1g', price: 250, reorder: 20, qty: 12, expiry: 45 },
  ];

  const drugs: Record<string, { id: string; price: number }> = {};
  for (const spec of drugSpecs) {
    const drug = await prisma.drug.create({
      data: {
        name: spec.name,
        genericName: spec.generic,
        form: spec.form,
        strength: spec.strength,
        unitPrice: spec.price,
        reorderLevel: spec.reorder,
      },
    });
    drugs[spec.name] = { id: drug.id, price: spec.price };
    const batch = await prisma.stockBatch.create({
      data: {
        drugId: drug.id,
        batchNo: `B-${spec.name.slice(0, 3).toUpperCase()}-001`,
        expiryDate: daysFromNow(spec.expiry),
        quantity: spec.qty,
        unitCost: spec.price * 0.6,
      },
    });
    await prisma.stockMovement.create({
      data: {
        drugId: drug.id, batchId: batch.id, type: 'RECEIPT', quantity: spec.qty,
        reason: 'Opening stock', performedById: pharmacist.staffId, reference: batch.batchNo,
      },
    });
  }
  // A near-expiry batch to exercise stock alerts
  await prisma.stockBatch.create({
    data: {
      drugId: drugs['Amoxicillin'].id,
      batchNo: 'B-AMO-002',
      expiryDate: daysFromNow(21),
      quantity: 60,
      unitCost: 7,
    },
  });

  // -------------------------------------------------------------------------
  // Lab catalog
  // -------------------------------------------------------------------------
  const labSpecs = [
    { code: 'FBC', name: 'Full Blood Count', price: 1200, sample: 'BLOOD', hours: 4 },
    { code: 'MRDT', name: 'Malaria Rapid Test', price: 500, sample: 'BLOOD', hours: 1 },
    { code: 'URA', name: 'Urinalysis', price: 700, sample: 'URINE', hours: 2 },
    { code: 'HBA1C', name: 'HbA1c', price: 2500, sample: 'BLOOD', hours: 24 },
    { code: 'LIPID', name: 'Lipid Profile', price: 3000, sample: 'BLOOD', hours: 24 },
    // Imaging is fulfilled by the same Diagnostics role, from the same worklist.
    { code: 'CXR', name: 'Chest X-Ray', price: 2000, sample: 'IMAGING', hours: 4 },
    { code: 'US-ABD', name: 'Abdominal Ultrasound', price: 3500, sample: 'IMAGING', hours: 6 },
  ];
  const labTests: Record<string, { id: string; price: number; name: string }> = {};
  for (const spec of labSpecs) {
    const test = await prisma.labTest.create({
      data: { code: spec.code, name: spec.name, price: spec.price, sampleType: spec.sample, turnaroundHours: spec.hours },
    });
    labTests[spec.code] = { id: test.id, price: spec.price, name: test.name };
  }

  // -------------------------------------------------------------------------
  // Wards & beds
  // -------------------------------------------------------------------------
  const medicalWard = await prisma.ward.create({
    data: {
      name: 'Medical Ward A', code: 'MWA', floor: '1st', capacity: 4,
      beds: { create: ['A-01', 'A-02', 'A-03', 'A-04'].map((label) => ({ label })) },
    },
    include: { beds: true },
  });
  const maternity = await prisma.ward.create({
    data: {
      name: 'Maternity', code: 'MAT', floor: '2nd', capacity: 3,
      beds: { create: ['M-01', 'M-02', 'M-03'].map((label) => ({ label })) },
    },
    include: { beds: true },
  });

  // One admitted patient so the ward board is not empty
  await prisma.bed.update({ where: { id: medicalWard.beds[0].id }, data: { status: 'OCCUPIED' } });
  await prisma.admission.create({
    data: {
      patientId: john.id,
      wardId: medicalWard.id,
      bedId: medicalWard.beds[0].id,
      doctorStaffId: doctorAmina.staffId,
      admittedById: reception.staffId,
      reason: 'Hypertensive crisis - observation',
      admittedAt: daysFromNow(-1),
    },
  });

  // -------------------------------------------------------------------------
  // Today's clinic: appointments, queue, encounter, prescription, lab, invoice
  // -------------------------------------------------------------------------
  const appointmentGrace = await prisma.appointment.create({
    data: {
      patientId: grace.id,
      doctorStaffId: doctorAmina.staffId,
      departmentId: general.id,
      startAt: todayAt(9, 0),
      endAt: todayAt(9, 20),
      status: 'CHECKED_IN',
      type: 'FOLLOW_UP',
      reason: 'Diabetes review and refill',
      room: 'Room 4',
      createdById: reception.userId,
      checkedInAt: todayAt(8, 50),
    },
  });

  await prisma.appointment.create({
    data: {
      patientId: peter.id,
      doctorStaffId: doctorAmina.staffId,
      departmentId: general.id,
      startAt: todayAt(9, 20),
      endAt: todayAt(9, 40),
      status: 'BOOKED',
      type: 'CONSULTATION',
      reason: 'Persistent cough',
      room: 'Room 4',
      createdById: reception.userId,
      bookedVia: 'PATIENT_PORTAL',
    },
  });

  await prisma.appointment.create({
    data: {
      patientId: amina.id,
      doctorStaffId: doctorBrian.staffId,
      departmentId: pediatrics.id,
      startAt: todayAt(10, 0),
      endAt: todayAt(10, 20),
      status: 'BOOKED',
      type: 'CONSULTATION',
      reason: 'Fever for 2 days',
      room: 'Room 7',
      createdById: reception.userId,
    },
  });

  await prisma.queueEntry.create({
    data: {
      ticketNo: 'GE-001',
      patientId: grace.id,
      appointmentId: appointmentGrace.id,
      doctorStaffId: doctorAmina.staffId,
      departmentId: general.id,
      priority: 'NORMAL',
      status: 'WAITING',
      checkedInAt: todayAt(8, 50),
      checkedInById: reception.userId,
    },
  });
  await prisma.queueEntry.create({
    data: {
      ticketNo: 'GE-002',
      patientId: john.id,
      doctorStaffId: doctorAmina.staffId,
      departmentId: general.id,
      priority: 'URGENT',
      status: 'WAITING',
      checkedInAt: todayAt(9, 5),
      checkedInById: reception.userId,
    },
  });

  // Grace's encounter: vitals, diagnosis, prescription, lab, bill
  const encounter = await prisma.encounter.create({
    data: {
      patientId: grace.id,
      doctorStaffId: doctorAmina.staffId,
      appointmentId: appointmentGrace.id,
      type: 'OPD',
      status: 'OPEN',
      chiefComplaint: 'Tiredness and blurred vision for one week',
      notes: 'Random glucose 11.8 mmol/L. Discussed diet, adherence and exercise.',
      plan: 'Continue metformin, repeat HbA1c in 3 months, review in 4 weeks.',
    },
  });

  await prisma.vitals.create({
    data: {
      patientId: grace.id,
      encounterId: encounter.id,
      recordedById: staffByEmail['nurse@medisync.test'].userId,
      temperatureC: 36.8,
      pulse: 82,
      respRate: 18,
      systolic: 138,
      diastolic: 86,
      spo2: 98,
      weightKg: 78.5,
      heightCm: 165,
      painScore: 1,
    },
  });

  await prisma.diagnosis.create({
    data: {
      patientId: grace.id,
      encounterId: encounter.id,
      code: 'E11.9',
      description: 'Type 2 diabetes mellitus without complications',
      type: 'PRIMARY',
      diagnosedById: doctorAmina.userId,
    },
  });

  const prescription = await prisma.prescription.create({
    data: {
      patientId: grace.id,
      encounterId: encounter.id,
      doctorStaffId: doctorAmina.staffId,
      status: 'PENDING',
      items: {
        create: [
          { drugId: drugs['Metformin'].id, dose: '500mg', frequency: 'Twice daily', durationDays: 30, quantity: 60, instructions: 'After meals' },
          { drugId: drugs['Paracetamol'].id, dose: '1g', frequency: 'Three times daily', durationDays: 5, quantity: 15, instructions: 'For headache' },
        ],
      },
    },
  });

  const labOrder = await prisma.labOrder.create({
    data: {
      patientId: grace.id,
      encounterId: encounter.id,
      orderedById: doctorAmina.staffId,
      testId: labTests['HBA1C'].id,
      priority: 'ROUTINE',
      status: 'COMPLETED',
      sampleBarcode: 'LAB-DEMO-HBA1C',
      clinicalNotes: 'Diabetes monitoring',
      completedAt: todayAt(8, 30),
      result: {
        create: {
          resultValue: '7.4',
          unit: '%',
          referenceRange: '4.0 - 5.6',
          flag: 'HIGH',
          interpretation: 'Above target. Reinforce adherence and diet at next review.',
          enteredById: labTech.userId,
          verifiedById: labTech.userId,
          verifiedAt: todayAt(8, 30),
        },
      },
    },
  });

  await prisma.labOrder.create({
    data: {
      patientId: grace.id,
      encounterId: encounter.id,
      orderedById: doctorAmina.staffId,
      testId: labTests['FBC'].id,
      priority: 'ROUTINE',
      status: 'ORDERED',
      sampleBarcode: 'LAB-DEMO-FBC',
    },
  });

  const consultationFee = 1500;
  const invoice = await prisma.invoice.create({
    data: {
      number: 'INV-SEED-0001',
      patientId: grace.id,
      encounterId: encounter.id,
      status: 'ISSUED',
      createdById: billing.userId,
      items: {
        create: [
          { description: 'Consultation - Dr Amina Odhiambo', category: 'CONSULTATION', quantity: 1, unitPrice: consultationFee, amount: consultationFee },
          { description: `Lab: ${labTests['HBA1C'].name}`, category: 'LAB', quantity: 1, unitPrice: labTests['HBA1C'].price, amount: labTests['HBA1C'].price },
          { description: `Lab: ${labTests['FBC'].name}`, category: 'LAB', quantity: 1, unitPrice: labTests['FBC'].price, amount: labTests['FBC'].price },
        ],
      },
    },
  });
  const subtotal = consultationFee + labTests['HBA1C'].price + labTests['FBC'].price;
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { subtotal, total: subtotal, balance: subtotal },
  });

  // Historical paid invoice so dashboards have data on day one
  const pastInvoice = await prisma.invoice.create({
    data: {
      number: 'INV-SEED-0002',
      patientId: peter.id,
      status: 'PAID',
      createdAt: daysFromNow(-6),
      issuedAt: daysFromNow(-6),
      items: {
        create: [{ description: 'Consultation - Dr Amina Odhiambo', category: 'CONSULTATION', quantity: 1, unitPrice: 1500, amount: 1500 }],
      },
    },
  });
  await prisma.invoice.update({
    where: { id: pastInvoice.id },
    data: { subtotal: 1500, total: 1500, amountPaid: 1500, balance: 0 },
  });
  await prisma.payment.create({
    data: {
      invoiceId: pastInvoice.id,
      receiptNo: 'RCT-SEED-0001',
      amount: 1500,
      method: 'MPESA',
      reference: 'QK47HJ2L9P',
      receivedById: billing.userId,
      paidAt: daysFromNow(-6),
    },
  });

  // A completed visit yesterday so the wait-time report has history
  const yesterday = daysFromNow(-1);
  const pastQueue = await prisma.queueEntry.create({
    data: {
      ticketNo: 'GE-014',
      patientId: peter.id,
      departmentId: general.id,
      doctorStaffId: doctorAmina.staffId,
      status: 'COMPLETED',
      checkedInAt: at(yesterday, 9, 0),
      startedAt: at(yesterday, 9, 24),
      completedAt: at(yesterday, 9, 45),
      createdAt: at(yesterday, 9, 0),
    },
  });
  void pastQueue;

  await prisma.systemSetting.upsert({
    where: { key: 'consultation_fee' },
    update: {},
    create: { key: 'consultation_fee', value: '1500', updatedById: staffByEmail['admin.it@medisync.test'].userId },
  });
  await prisma.systemSetting.upsert({
    where: { key: 'hospital_name' },
    update: {},
    create: { key: 'hospital_name', value: 'MEDI SYNC General Hospital', updatedById: staffByEmail['admin.it@medisync.test'].userId },
  });

  await prisma.notification.create({
    data: {
      userId: graceUser.id,
      title: 'Welcome to MEDI SYNC',
      body: 'Book appointments, view results and pay bills from any device.',
      type: 'INFO',
      link: '/portal',
    },
  });

  await prisma.messageThread.create({
    data: {
      patientId: grace.id,
      subject: 'Question about my metformin dose',
      createdById: graceUser.id,
      messages: {
        create: [
          { senderId: graceUser.id, body: 'Hello doctor, should I take metformin before or after breakfast?' },
          { senderId: doctorAmina.userId, body: 'After breakfast is best for you. Please keep the evening dose as prescribed.' },
        ],
      },
    },
  });

  void pharmacist;
  void prescription;
  void labOrder;
  void maternity;

  console.log('Seed complete.');
  console.log('Demo password for every account: ' + DEMO_PASSWORD);
  console.log('MFA TOTP secret (staff): ' + DEMO_TOTP_SECRET);
  console.log('Current TOTP code now: ' + authenticator.generate(DEMO_TOTP_SECRET));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
