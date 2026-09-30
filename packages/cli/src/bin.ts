#!/usr/bin/env node
import { installWarningFilter } from './node-warnings.ts';
import { run } from './program.ts';

installWarningFilter();
run(process.argv);
