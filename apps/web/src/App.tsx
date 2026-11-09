import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { landingFor, useAuth } from './lib/auth';
import { FullPageLoader, Layout, NotFound } from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import Security from './pages/Security';
import Dashboard from './pages/Dashboard';
import Patients from './pages/Patients';
import PatientDetail from './pages/PatientDetail';
import Appointments from './pages/Appointments';
import Reception from './pages/Reception';
import Queue from './pages/Queue';
import QueueBoard from './pages/QueueBoard';
import DoctorToday from './pages/DoctorToday';
import Encounter from './pages/Encounter';
import Pharmacy from './pages/Pharmacy';
import Lab from './pages/Lab';
import Billing from './pages/Billing';
import Wards from './pages/Wards';
import Messages from './pages/Messages';
import Reports from './pages/Reports';
import Admin from './pages/Admin';
import PortalHome from './pages/portal/PortalHome';
import PortalAppointments from './pages/portal/PortalAppointments';
import PortalRecords from './pages/portal/PortalRecords';
import PortalBills from './pages/portal/PortalBills';
import PortalGuardians from './pages/portal/PortalGuardians';

function RequireSession() {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageLoader />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Layout />;
}

/** Staff-only route; portal users are redirected to their own home. */
function StaffOnly() {
  const { me } = useAuth();
  if (me?.portal === 'patient') return <Navigate to="/portal" replace />;
  return <Outlet />;
}

function Landing() {
  const { me, loading } = useAuth();
  if (loading) return <FullPageLoader />;
  if (!me) return <Navigate to="/login" replace />;
  return <Navigate to={landingFor(me)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      <Route element={<RequireSession />}>
        <Route path="/" element={<Landing />} />
        <Route path="/security" element={<Security />} />
        <Route path="/messages" element={<Messages />} />

        <Route element={<StaffOnly />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/doctor" element={<DoctorToday />} />
          <Route path="/reception" element={<Reception />} />
          <Route path="/patients" element={<Patients />} />
          <Route path="/patients/:id" element={<PatientDetail />} />
          <Route path="/appointments" element={<Appointments />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/board" element={<QueueBoard />} />
          <Route path="/consultation/:id" element={<Encounter />} />
          <Route path="/consultation/new" element={<Encounter />} />
          <Route path="/pharmacy" element={<Pharmacy />} />
          <Route path="/lab" element={<Lab />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/wards" element={<Wards />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/admin" element={<Admin />} />
        </Route>

        <Route path="/portal">
          <Route index element={<PortalHome />} />
          <Route path="appointments" element={<PortalAppointments />} />
          <Route path="records" element={<PortalRecords />} />
          <Route path="bills" element={<PortalBills />} />
          <Route path="guardians" element={<PortalGuardians />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
