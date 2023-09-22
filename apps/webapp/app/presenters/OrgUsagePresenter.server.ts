import { PrismaClient, prisma } from "~/db.server";

export class OrgUsagePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, slug }: { userId: string; slug: string }) {
    const organization = await this.#prismaClient.organization.findFirst({
      where: {
        slug,
        members: {
          some: {
            userId,
          },
        },
      },
    });

    if (!organization) {
      throw new Error("Organization not found");
    }

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const startOfLastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1); // this works for January as well

    // Get count of runs since the start of the current month
    const runsCount = await this.#prismaClient.jobRun.count({
      where: {
        organizationId: organization.id,
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
    });

    // Get the count of runs for last month
    const runsCountLastMonth = await this.#prismaClient.jobRun.count({
      where: {
        organizationId: organization.id,
        createdAt: {
          gte: startOfLastMonth,
          lt: startOfMonth,
        },
      },
    });

    // Get the count of the runs for the last 6 months, by month. So for example we want the data shape to be:
    // [
    //   { month: "2021-01", count: 10 },
    //   { month: "2021-02", count: 20 },
    //   { month: "2021-03", count: 30 },
    //   { month: "2021-04", count: 40 },
    //   { month: "2021-05", count: 50 },
    //   { month: "2021-06", count: 60 },
    // ]
    // This will be used to generate the chart on the usage page
    // Use prisma queryRaw for this since prisma doesn't support grouping by month
    const runsCountLastSixMonthsRaw = await this.#prismaClient.$queryRaw<
      {
        month: string;
        count: number;
      }[]
    >`SELECT TO_CHAR("createdAt", 'YYYY-MM') as month, COUNT(*) as count FROM "JobRun" WHERE "organizationId" = ${organization.id} AND "createdAt" >= NOW() - INTERVAL '6 months' GROUP BY month ORDER BY month ASC`;

    const runsCountLastSixMonths = runsCountLastSixMonthsRaw.map((obj) => ({
      name: obj.month,
      total: Number(obj.count), // Convert BigInt to Number
    }));

    const totalJobs = await this.#prismaClient.job.count({
      where: {
        organizationId: organization.id,
        internal: false,
      },
    });

    const totalJobsLastMonth = await this.#prismaClient.job.count({
      where: {
        organizationId: organization.id,
        createdAt: {
          lt: startOfMonth,
        },
        deletedAt: null,
        internal: false,
      },
    });

    const totalIntegrations = await this.#prismaClient.integration.count({
      where: {
        organizationId: organization.id,
      },
    });

    const totalIntegrationsLastMonth = await this.#prismaClient.integration.count({
      where: {
        organizationId: organization.id,
        createdAt: {
          lt: startOfMonth,
        },
      },
    });

    const totalMembers = await this.#prismaClient.orgMember.count({
      where: {
        organizationId: organization.id,
      },
    });

    const jobs = await this.#prismaClient.job.findMany({
      where: {
        organizationId: organization.id,
        deletedAt: null,
        internal: false,
      },
      select: {
        id: true,
        slug: true,
        _count: {
          select: {
            runs: {
              where: {
                createdAt: {
                  gte: startOfMonth,
                },
              },
            },
          },
        },
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    return {
      id: organization.id,
      runsCount,
      runsCountLastMonth,
      runsCountLastSixMonths,
      totalJobs,
      totalJobsLastMonth,
      totalIntegrations,
      totalIntegrationsLastMonth,
      totalMembers,
      jobs,
    };
  }
}
