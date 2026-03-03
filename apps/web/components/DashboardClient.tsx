'use client';

import { useState } from 'react';
import { CreateVideoForm } from './CreateVideoForm';
import { CreditBalance } from './CreditBalance';
import { JobTable } from './JobTable';

export function DashboardClient() {
  const [refreshKey, setRefreshKey] = useState(0);

  const triggerRefresh = () => {
    setRefreshKey((current) => current + 1);
  };

  return (
    <>
      <CreditBalance refreshKey={refreshKey} />
      <CreateVideoForm onJobCreated={triggerRefresh} />
      <JobTable refreshKey={refreshKey} />
    </>
  );
}
