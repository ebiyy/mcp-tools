declare module 'npm-registry-fetch' {
  namespace npmFetch {
    interface PackageInfo {
      name: string;
      'dist-tags': {
        latest: string;
      };
      versions: {
        [version: string]: {
          description?: string;
          author?: {
            name?: string;
            email?: string;
            url?: string;
          };
          homepage?: string;
          repository?: {
            type: string;
            url: string;
          };
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
      };
      time: Record<string, string>;
    }

    function json(packageName: string): Promise<PackageInfo>;
  }
  export = npmFetch;
}

export interface PackageInfoArgs {
  packageName: string;
}

export interface ReleaseHistoryArgs {
  packageName: string;
  limit?: number;
}

export interface DependencyAnalysisArgs {
  packageName: string;
}