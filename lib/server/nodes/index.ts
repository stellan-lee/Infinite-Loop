import type { NodeExecutor, NodeType } from '../../shared/workflow';
import { startExecutor } from './start';
import { endExecutor } from './end';
import { agentExecutor } from './agent';
import { conditionExecutor } from './condition';
import { loopExecutor } from './loop';
import { branchExecutor } from './branch';
import { parallelExecutor } from './parallel';
import { subworkflowExecutor } from './subworkflow';
import { judgeExecutor } from './judge';
import { sidenoteExecutor } from './sidenote';
import { scriptExecutor } from './script';
import { manualExecutor } from './manual';

export const nodeExecutors: Record<NodeType, NodeExecutor> = {
  start: startExecutor,
  end: endExecutor,
  agent: agentExecutor,
  condition: conditionExecutor,
  loop: loopExecutor,
  branch: branchExecutor,
  parallel: parallelExecutor,
  subworkflow: subworkflowExecutor,
  judge: judgeExecutor,
  sidenote: sidenoteExecutor,
  script: scriptExecutor,
  manual: manualExecutor,
};
