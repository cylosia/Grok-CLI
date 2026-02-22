import { ToolResult } from '../types/index.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoPriority = 'high' | 'medium' | 'low';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export interface TodoUpdate {
  id: string;
  status?: TodoStatus;
  content?: string;
  priority?: TodoPriority;
}

const TODO_STATUSES: ReadonlyArray<TodoStatus> = ['pending', 'in_progress', 'completed'];
const TODO_PRIORITIES: ReadonlyArray<TodoPriority> = ['high', 'medium', 'low'];

function assertNever(value: never): never {
  throw new Error(`Unhandled todo status: ${String(value)}`);
}

export class TodoTool {
  private todos: TodoItem[] = [];

  formatTodoList(): string {
    if (this.todos.length === 0) {
      return 'No todos created yet';
    }

    const getCheckbox = (status: TodoStatus): string => {
      switch (status) {
        case 'completed':
          return '●';
        case 'in_progress':
          return '◐';
        case 'pending':
          return '○';
        default:
          return assertNever(status);
      }
    };

    const getStatusColor = (status: TodoStatus): string => {
      switch (status) {
        case 'completed':
          return '\x1b[32m';
        case 'in_progress':
          return '\x1b[36m';
        case 'pending':
          return '\x1b[37m';
        default:
          return assertNever(status);
      }
    };

    const reset = '\x1b[0m';
    let output = '';

    this.todos.forEach((todo, index) => {
      const checkbox = getCheckbox(todo.status);
      const statusColor = getStatusColor(todo.status);
      const strikethrough = todo.status === 'completed' ? '\x1b[9m' : '';
      const indent = index === 0 ? '' : '  ';

      output += `${indent}${statusColor}${strikethrough}${checkbox} ${todo.content}${reset}\n`;
    });

    return output;
  }

  async createTodoList(todos: TodoItem[]): Promise<ToolResult> {
    try {
      for (const todo of todos) {
        if (!todo.id || !todo.content || !todo.status || !todo.priority) {
          return {
            success: false,
            error: 'Each todo must have id, content, status, and priority fields'
          };
        }

        if (!TODO_STATUSES.includes(todo.status)) {
          return {
            success: false,
            error: `Invalid status: ${todo.status}. Must be pending, in_progress, or completed`
          };
        }

        if (!TODO_PRIORITIES.includes(todo.priority)) {
          return {
            success: false,
            error: `Invalid priority: ${todo.priority}. Must be high, medium, or low`
          };
        }
      }

      const ids = new Set<string>();
      for (const todo of todos) {
        if (ids.has(todo.id)) {
          return {
            success: false,
            error: `Duplicate todo id: ${todo.id}`
          };
        }
        ids.add(todo.id);
      }

      this.todos = todos;

      return {
        success: true,
        output: this.formatTodoList()
      };
    } catch (error) {
      return {
        success: false,
        error: `Error creating todo list: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async updateTodoList(updates: TodoUpdate[]): Promise<ToolResult> {
    try {
      for (const update of updates) {
        const todoIndex = this.todos.findIndex(t => t.id === update.id);

        if (todoIndex === -1) {
          return {
            success: false,
            error: `Todo with id ${update.id} not found`
          };
        }

        const todo = this.todos[todoIndex];
        if (!todo) {
          return { success: false, error: `Todo at index ${todoIndex} not found` };
        }

        if (update.status !== undefined && !TODO_STATUSES.includes(update.status)) {
          return {
            success: false,
            error: `Invalid status: ${update.status}. Must be pending, in_progress, or completed`
          };
        }

        if (update.priority !== undefined && !TODO_PRIORITIES.includes(update.priority)) {
          return {
            success: false,
            error: `Invalid priority: ${update.priority}. Must be high, medium, or low`
          };
        }

        if (update.status !== undefined) todo.status = update.status;
        if (update.content !== undefined) todo.content = update.content;
        if (update.priority !== undefined) todo.priority = update.priority;
      }

      return {
        success: true,
        output: this.formatTodoList()
      };
    } catch (error) {
      return {
        success: false,
        error: `Error updating todo list: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async viewTodoList(): Promise<ToolResult> {
    return {
      success: true,
      output: this.formatTodoList()
    };
  }
}
