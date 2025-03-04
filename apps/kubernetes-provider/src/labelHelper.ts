import { assertExhaustive } from "@trigger.dev/core";

const CREATE_LABEL_ENV_VAR_PREFIX = "DEPLOYMENT_LABEL_";
const RESTORE_LABEL_ENV_VAR_PREFIX = "RESTORE_LABEL_";
const LABEL_SAMPLE_RATE_POSTFIX = "_SAMPLE_RATE";

type OperationType = "create" | "restore";

type CustomLabel = {
  key: string;
  value: string;
  sampleRate: number;
};

export class CustomLabelHelper {
  // Labels and sample rates are defined in environment variables so only need to be computed once
  private createLabels?: CustomLabel[];
  private restoreLabels?: CustomLabel[];

  private getLabelPrefix(type: OperationType) {
    const prefix = type === "create" ? CREATE_LABEL_ENV_VAR_PREFIX : RESTORE_LABEL_ENV_VAR_PREFIX;
    return prefix.toLowerCase();
  }

  private getLabelSampleRatePostfix() {
    return LABEL_SAMPLE_RATE_POSTFIX.toLowerCase();
  }

  // Can only range from 0 to 1
  private fractionFromPercent(percent: number) {
    return Math.min(1, Math.max(0, percent / 100));
  }

  private isLabelSampleRateEnvVar(key: string) {
    return key.toLowerCase().endsWith(this.getLabelSampleRatePostfix());
  }

  private isLabelEnvVar(type: OperationType, key: string) {
    const prefix = this.getLabelPrefix(type);
    return key.toLowerCase().startsWith(prefix) && !this.isLabelSampleRateEnvVar(key);
  }

  private getSampleRateEnvVarKey(type: OperationType, envKey: string) {
    return `${envKey.toLowerCase()}${this.getLabelSampleRatePostfix()}`;
  }

  private getLabelNameFromEnvVarKey(type: OperationType, key: string) {
    return key
      .slice(this.getLabelPrefix(type).length)
      .toLowerCase()
      .replace(/___/g, ".")
      .replace(/__/g, "/")
      .replace(/_/g, "-");
  }

  private getCaseInsensitiveEnvValue(key: string) {
    for (const [envKey, value] of Object.entries(process.env)) {
      if (envKey.toLowerCase() === key.toLowerCase()) {
        return value;
      }
    }
  }

  /** Returns the sample rate for a given label as fraction of 100 */
  private getSampleRateFromEnvVarKey(type: OperationType, envKey: string) {
    // Apply default: always sample
    const DEFAULT_SAMPLE_RATE_PERCENT = 100;
    const defaultSampleRateFraction = this.fractionFromPercent(DEFAULT_SAMPLE_RATE_PERCENT);

    const value = this.getCaseInsensitiveEnvValue(this.getSampleRateEnvVarKey(type, envKey));

    if (!value) {
      return defaultSampleRateFraction;
    }

    const sampleRatePercent = parseFloat(value || String(DEFAULT_SAMPLE_RATE_PERCENT));

    if (isNaN(sampleRatePercent)) {
      return defaultSampleRateFraction;
    }

    const fractionalSampleRate = this.fractionFromPercent(sampleRatePercent);

    return fractionalSampleRate;
  }

  private getCustomLabels(type: OperationType): CustomLabel[] {
    switch (type) {
      case "create":
        if (this.createLabels) {
          return this.createLabels;
        }
        break;
      case "restore":
        if (this.restoreLabels) {
          return this.restoreLabels;
        }
        break;
      default:
        assertExhaustive(type);
    }

    const customLabels: CustomLabel[] = [];

    for (const [envKey, value] of Object.entries(process.env)) {
      const key = envKey.toLowerCase();

      // Only process env vars that start with the expected prefix
      if (!this.isLabelEnvVar(type, key)) {
        continue;
      }

      // Skip sample rates - deal with them separately
      if (this.isLabelSampleRateEnvVar(key)) {
        continue;
      }

      const labelName = this.getLabelNameFromEnvVarKey(type, key);
      const sampleRate = this.getSampleRateFromEnvVarKey(type, key);

      const label = {
        key: labelName,
        value: value || "",
        sampleRate,
      } satisfies CustomLabel;

      customLabels.push(label);
    }

    return customLabels;
  }

  getAdditionalLabels(type: OperationType): Record<string, string> {
    const labels = this.getCustomLabels(type);

    const additionalLabels: Record<string, string> = {};

    for (const { key, value, sampleRate } of labels) {
      // Always apply label if sample rate is 1
      if (sampleRate === 1) {
        additionalLabels[key] = value;
        continue;
      }

      if (Math.random() <= sampleRate) {
        additionalLabels[key] = value;
        continue;
      }
    }

    return additionalLabels;
  }
}
