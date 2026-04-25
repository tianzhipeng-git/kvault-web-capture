export class RunTargetTracker {
  private candidateSuccessCount = 0;
  private targetReachedLogged = false;

  constructor(private readonly targetSuccessCount: number | null) {}

  isEnabled(): boolean {
    return this.targetSuccessCount !== null && this.targetSuccessCount > 0;
  }

  isReached(): boolean {
    return this.isEnabled() && this.candidateSuccessCount >= this.targetSuccessCount!;
  }

  recordCandidateSuccess(): { reachedNow: boolean; count: number; target: number | null } {
    if (!this.isEnabled()) {
      return {
        reachedNow: false,
        count: this.candidateSuccessCount,
        target: this.targetSuccessCount,
      };
    }

    this.candidateSuccessCount += 1;

    const reachedNow = this.isReached() && !this.targetReachedLogged;
    if (reachedNow) {
      this.targetReachedLogged = true;
    }

    return {
      reachedNow,
      count: this.candidateSuccessCount,
      target: this.targetSuccessCount,
    };
  }

  getCandidateSuccessCount(): number {
    return this.candidateSuccessCount;
  }
}
