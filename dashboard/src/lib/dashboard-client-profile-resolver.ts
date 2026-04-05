import { dashboardClientProfile, type DashboardClientProfile } from "@/lib/dashboard-client-profile";

export interface ResolveDashboardProfileInput {
  clientName: string;
}

export interface DashboardClientProfileResolver {
  resolve(input: ResolveDashboardProfileInput): DashboardClientProfile;
}

export class DefaultDashboardClientProfileResolver implements DashboardClientProfileResolver {
  resolve(_input: ResolveDashboardProfileInput): DashboardClientProfile {
    return dashboardClientProfile;
  }
}
