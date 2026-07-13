export function alwaysLearningKey(proposalType: string): string {
  return `proposal:${proposalType}:always`;
}

export function canAutoExecuteProposal(input: { reversible: boolean; risk: string; proposalType?: string }): boolean {
  const proposalType = input.proposalType?.toLocaleLowerCase('en-US') ?? '';
  const alwaysRequiresConfirmation = proposalType === 'profile_change'
    || proposalType.includes('permission')
    || proposalType.includes('recipient')
    || proposalType.includes('external');
  return input.reversible && input.risk !== 'destructive' && !alwaysRequiresConfirmation;
}
