import { readGameInput } from "./keypress.ts";

// 游戏配置接口
interface GameConfig {
    width: number;
    height: number;
    speed: number;
    difficulty: "easy" | "medium" | "hard";
    withWalls: boolean;
    withObstacles: boolean;
}

// 方向枚举
enum Direction {
    Up = "up",
    Down = "down",
    Left = "left",
    Right = "right"
}

// 游戏状态枚举
enum GameState {
    Menu = "menu",
    Playing = "playing",
    Paused = "paused",
    GameOver = "gameover"
}

// 游戏单元格类型
type CellType = "empty" | "snake" | "head" | "food" | "wall" | "obstacle";

// 坐标点
interface Point {
    x: number;
    y: number;
}

// 贪吃蛇类
class Snake {
    body: Point[];
    direction: Direction;
    nextDirection: Direction;
    growthPending: number;

    constructor(startX: number, startY: number) {
        this.body = [
            { x: startX, y: startY },
            { x: startX - 1, y: startY },
            { x: startX - 2, y: startY }
        ];
        this.direction = Direction.Right;
        this.nextDirection = Direction.Right;
        this.growthPending = 0;
    }

    // 改变方向
    changeDirection(newDirection: Direction): void {
        // 防止直接反向移动
        if (
            (newDirection === Direction.Up && this.direction !== Direction.Down) ||
            (newDirection === Direction.Down && this.direction !== Direction.Up) ||
            (newDirection === Direction.Left && this.direction !== Direction.Right) ||
            (newDirection === Direction.Right && this.direction !== Direction.Left)
        ) {
            this.nextDirection = newDirection;
        }
    }

    // 移动蛇
    move(): Point | null {
        this.direction = this.nextDirection;
        const head = { ...this.body[0] };

        // 根据方向移动头部
        switch (this.direction) {
            case Direction.Up:
                head.y -= 1;
                break;
            case Direction.Down:
                head.y += 1;
                break;
            case Direction.Left:
                head.x -= 1;
                break;
            case Direction.Right:
                head.x += 1;
                break;
        }

        // 添加新的头部
        this.body.unshift(head);

        // 如果有增长待处理，不移除尾部
        if (this.growthPending > 0) {
            this.growthPending--;
            return null;
        } else {
            // 否则移除尾部
            return this.body.pop()!;
        }
    }

    // 检查是否撞到自己
    checkSelfCollision(): boolean {
        const head = this.body[0];
        for (let i = 1; i < this.body.length; i++) {
            if (this.body[i].x === head.x && this.body[i].y === head.y) {
                return true;
            }
        }
        return false;
    }

    // 增长蛇
    grow(): void {
        this.growthPending += 3; // 每吃一个食物增长3节
    }
}

// 游戏类
class SnakeGame {
    private config: GameConfig;
    private snake: Snake;
    private food: Point;
    private walls: Point[];
    private obstacles: Point[];
    private score: number;
    private highScore: number;
    private state: GameState;
    private frameCount: number;
    private menuOption: number;
    private gameBoard: CellType[][];
    private foodEaten: number;
    private difficultyOptions: Array<GameConfig["difficulty"]> = ["easy", "medium", "hard"];
    private menuOptions = ["开始游戏", "难度选择", "墙壁模式", "加障碍物", "退出游戏"];

    constructor() {
        // 默认配置
        this.config = {
            width: 38,
            height: 15,
            speed: 10,
            difficulty: "medium",
            withWalls: true,
            withObstacles: false
        };

        this.snake = new Snake(Math.floor(this.config.width / 2), Math.floor(this.config.height / 2));
        this.food = { x: 0, y: 0 };
        this.walls = [];
        this.obstacles = [];
        this.score = 0;
        this.highScore = 0;
        this.state = GameState.Menu;
        this.frameCount = 0;
        this.menuOption = 0;
        this.gameBoard = [];
        this.foodEaten = 0;

        // 初始化游戏板
        this.initializeBoard();
        // 生成墙壁
        this.generateWalls();
        // 生成食物
        this.generateFood();
    }

    // 初始化游戏板
    private initializeBoard(): void {
        this.gameBoard = Array(this.config.height).fill(null).map(() =>
            Array(this.config.width).fill("empty" as CellType)
        );
    }

    // 生成墙壁
    private generateWalls(): void {
        this.walls = [];
        if (!this.config.withWalls) return;

        // 生成边界墙壁
        for (let y = 0; y < this.config.height; y++) {
            for (let x = 0; x < this.config.width; x++) {
                if (y === 0 || y === this.config.height - 1 || x === 0 || x === this.config.width - 1) {
                    this.walls.push({ x, y });
                }
            }
        }
    }

    // 生成障碍物
    private generateObstacles(): void {
        this.obstacles = [];
        if (!this.config.withObstacles) return;

        // 生成一些随机障碍物
        const obstacleCount = Math.floor((this.config.width * this.config.height) * 0.05);

        for (let i = 0; i < obstacleCount; i++) {
            let obstacle: Point;
            let validPosition = false;

            // 确保障碍物不在蛇身上或食物上
            while (!validPosition) {
                obstacle = {
                    x: Math.floor(Math.random() * (this.config.width - 2)) + 1,
                    y: Math.floor(Math.random() * (this.config.height - 2)) + 1
                };

                // 检查是否与蛇重叠
                const onSnake = this.snake.body.some(segment =>
                    segment.x === obstacle.x && segment.y === obstacle.y
                );

                // 检查是否与食物重叠
                const onFood = this.food.x === obstacle.x && this.food.y === obstacle.y;

                // 检查是否与其他障碍物重叠
                const onObstacle = this.obstacles.some(obs =>
                    obs.x === obstacle.x && obs.y === obstacle.y
                );

                if (!onSnake && !onFood && !onObstacle) {
                    this.obstacles.push(obstacle);
                    validPosition = true;
                }
            }
        }
    }

    // 生成食物
    private generateFood(): void {
        let food: Point;
        let validPosition = false;

        while (!validPosition) {
            food = {
                x: Math.floor(Math.random() * this.config.width),
                y: Math.floor(Math.random() * this.config.height)
            };

            // 检查是否与蛇重叠
            const onSnake = this.snake.body.some(segment =>
                segment.x === food.x && segment.y === food.y
            );

            // 检查是否与墙壁重叠
            const onWall = this.walls.some(wall =>
                wall.x === food.x && wall.y === food.y
            );

            // 检查是否与障碍物重叠
            const onObstacle = this.obstacles.some(obstacle =>
                obstacle.x === food.x && obstacle.y === food.y
            );

            if (!onSnake && !onWall && !onObstacle) {
                this.food = food;
                validPosition = true;
            }
        }
    }

    // 更新游戏板
    private updateBoard(): void {
        // 清空游戏板
        this.initializeBoard();

        // 放置墙壁
        for (const wall of this.walls) {
            if (wall.x >= 0 && wall.x < this.config.width && wall.y >= 0 && wall.y < this.config.height) {
                this.gameBoard[wall.y][wall.x] = "wall";
            }
        }

        // 放置障碍物
        for (const obstacle of this.obstacles) {
            if (obstacle.x >= 0 && obstacle.x < this.config.width && obstacle.y >= 0 && obstacle.y < this.config.height) {
                this.gameBoard[obstacle.y][obstacle.x] = "obstacle";
            }
        }

        // 放置食物
        if (this.food.x >= 0 && this.food.x < this.config.width && this.food.y >= 0 && this.food.y < this.config.height) {
            this.gameBoard[this.food.y][this.food.x] = "food";
        }

        // 放置蛇的身体
        for (let i = 0; i < this.snake.body.length; i++) {
            const segment = this.snake.body[i];
            if (segment.x >= 0 && segment.x < this.config.width && segment.y >= 0 && segment.y < this.config.height) {
                this.gameBoard[segment.y][segment.x] = i === 0 ? "head" : "snake";
            }
        }
    }

    // 游戏逻辑更新
    update(): void {
        if (this.state !== GameState.Playing) return;

        // 根据难度调整速度
        let speed = this.config.speed;
        switch (this.config.difficulty) {
            case "easy":
                speed = 8;
                break;
            case "hard":
                speed = 15;
                break;
        }

        // 控制游戏速度
        if (this.frameCount % Math.floor(60 / speed) !== 0) {
            this.frameCount++;
            return;
        }

        this.frameCount++;

        // 移动蛇
        const removedTail = this.snake.move();

        // 检查边界碰撞（如果有墙壁）
        const head = this.snake.body[0];
        if (this.config.withWalls) {
            if (
                head.x < 0 || head.x >= this.config.width ||
                head.y < 0 || head.y >= this.config.height
            ) {
                this.state = GameState.GameOver;
                return;
            }
        } else {
            // 如果没有墙壁，则穿墙
            if (head.x < 0) head.x = this.config.width - 1;
            if (head.x >= this.config.width) head.x = 0;
            if (head.y < 0) head.y = this.config.height - 1;
            if (head.y >= this.config.height) head.y = 0;
        }

        // 检查自身碰撞
        if (this.snake.checkSelfCollision()) {
            this.state = GameState.GameOver;
            return;
        }

        // 检查障碍物碰撞
        if (this.config.withObstacles) {
            for (const obstacle of this.obstacles) {
                if (head.x === obstacle.x && head.y === obstacle.y) {
                    this.state = GameState.GameOver;
                    return;
                }
            }
        }

        // 检查是否吃到食物
        if (head.x === this.food.x && head.y === this.food.y) {
            this.snake.grow();
            this.score += 10 * (this.config.difficulty === "easy" ? 1 : this.config.difficulty === "medium" ? 2 : 3);
            this.foodEaten++;

            // 每吃5个食物生成新的障碍物（如果启用）
            if (this.config.withObstacles && this.foodEaten % 5 === 0) {
                this.generateObstacles();
            }

            // 更新最高分
            if (this.score > this.highScore) {
                this.highScore = this.score;
            }

            // 生成新食物
            this.generateFood();
        }

        // 更新游戏板
        this.updateBoard();
    }

    // 绘制游戏
    draw(): void {
        // 清屏
        console.clear();

        // 根据游戏状态绘制不同界面
        switch (this.state) {
            case GameState.Menu:
                this.drawMenu();
                break;
            case GameState.Playing:
            case GameState.Paused:
            case GameState.GameOver:
                this.drawGame();
                break;
        }
    }

    // 绘制菜单
    private drawMenu(): void {
        console.log("╔════════════════════════════════════════╗");
        console.log("║         🐍 终端贪吃蛇游戏 🐍           ║");
        console.log("╠════════════════════════════════════════╣");
        console.log("║                                        ║");

        // 绘制菜单选项
        for (let i = 0; i < this.menuOptions.length; i++) {
            const option = this.menuOptions[i];
            const prefix = i === this.menuOption ? "➤ " : "  ";
            console.log(`║  ${prefix}${option}                            ║`);
        }

        console.log("║                                        ║");
        console.log("╠════════════════════════════════════════╣");
        console.log("║        控制: ↑↓ 选择, Enter 确认       ║");
        console.log("║        游戏时: WASD/方向键移动         ║");
        console.log("║        P 暂停, Q 退出, R 重新开始      ║");
        console.log("╚════════════════════════════════════════╝");
    }

    // 绘制游戏界面
    private drawGame(): void {
        // 游戏标题和状态
        let title = "贪吃蛇游戏";
        if (this.state === GameState.Paused) title = "游戏已暂停";
        if (this.state === GameState.GameOver) title = "游戏结束!";

        console.log("╔════════════════════════════════════════╗");
        console.log(`║         🐍 ${title} 🐍         ║`);
        console.log("╠════════════════════════════════════════╣");

        // 游戏信息
        console.log(`║ 得分: ${this.score.toString().padEnd(6)} 最高分: ${this.highScore.toString().padEnd(6)} 长度: ${this.snake.body.length.toString().padEnd(3)}  ║`);
        console.log(`║ 难度: ${this.config.difficulty.padEnd(8)} 食物: ${this.foodEaten.toString().padEnd(4)} ${this.config.withWalls ? "墙壁" : "    "}  ${this.config.withObstacles ? '障碍' : '    '}   ║`);
        console.log("╠════════════════════════════════════════╣");

        // 绘制游戏板
        for (let y = 0; y < this.config.height; y++) {
            let line = "║ ";
            for (let x = 0; x < this.config.width; x++) {
                const cell = this.gameBoard[y][x];
                switch (cell) {
                    case "empty":
                        line += " ";
                        break;
                    case "snake":
                        line += "●";
                        break;
                    case "head":
                        line += "◉";
                        break;
                    case "food":
                        line += "★";
                        break;
                    case "wall":
                        line += "█";
                        break;
                    case "obstacle":
                        line += "X";
                        break;
                    default:
                        line += " ";
                }
            }
            line += " ║";
            console.log(line);
        }

        console.log("╠════════════════════════════════════════╣");

        // 游戏状态提示
        if (this.state === GameState.Playing) {
            console.log("║ 控制: WASD/方向键移动, P暂停, Q退出    ║");
        } else if (this.state === GameState.Paused) {
            console.log("║        游戏已暂停 - 按P继续           ║");
        } else if (this.state === GameState.GameOver) {
            console.log("║      游戏结束! 按R重玩, Q返回菜单     ║");
        }

        console.log("╚════════════════════════════════════════╝");
    }

    // 处理输入
    async handleInput(): Promise<void> {
        for await (const keypress of readGameInput()) {
            if (keypress.key === "q" || keypress.key === "Q") {
                if (this.state === GameState.Playing || this.state === GameState.Paused) {
                    this.state = GameState.Menu;
                    this.resetGame();
                } else if (this.state === GameState.GameOver) {
                    this.state = GameState.Menu;
                }
            } else if (keypress.key === "r" || keypress.key === "R") {
                if (this.state === GameState.GameOver) {
                    this.resetGame();
                    this.state = GameState.Playing;
                }
            } else if (keypress.key === "p" || keypress.key === "P") {
                if (this.state === GameState.Playing) {
                    this.state = GameState.Paused;
                } else if (this.state === GameState.Paused) {
                    this.state = GameState.Playing;
                }
            }

            // 菜单控制
            if (this.state === GameState.Menu) {
                if (keypress.key === "up") {
                    this.menuOption = (this.menuOption - 1 + this.menuOptions.length) % this.menuOptions.length;
                } else if (keypress.key === "down") {
                    this.menuOption = (this.menuOption + 1) % this.menuOptions.length;
                } else if (keypress.key === "return" || keypress.key === "enter") {
                    await this.handleMenuSelection();
                }
            }

            // 游戏控制
            if (this.state === GameState.Playing) {
                if (keypress.key === "up" || keypress.key === "w" || keypress.key === "W") {
                    this.snake.changeDirection(Direction.Up);
                } else if (keypress.key === "down" || keypress.key === "s" || keypress.key === "S") {
                    this.snake.changeDirection(Direction.Down);
                } else if (keypress.key === "left" || keypress.key === "a" || keypress.key === "A") {
                    this.snake.changeDirection(Direction.Left);
                } else if (keypress.key === "right" || keypress.key === "d" || keypress.key === "D") {
                    this.snake.changeDirection(Direction.Right);
                }
            }

            // 重新绘制
            this.draw();
        }
    }

    // 处理菜单选择
    private async handleMenuSelection() {
        switch (this.menuOption) {
            case 0: // 开始游戏
                this.resetGame();
                this.state = GameState.Playing;
                break;
            case 1: // 难度选择
                this.config.difficulty = this.difficultyOptions[
                    (this.difficultyOptions.indexOf(this.config.difficulty) + 1) % this.difficultyOptions.length
                ] ?? "medium";
                console.log(`难度已设置为 ${this.config.difficulty}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                break;
            case 2: // 墙壁模式
                this.config.withWalls = !this.config.withWalls;
                this.generateWalls();
                console.log(`墙壁模式已设置为 ${this.config.withWalls ? "开" : "关"}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                break;
            case 3: // 障碍物模式
                this.config.withObstacles = !this.config.withObstacles;
                if (this.config.withObstacles) {
                    this.generateObstacles();
                } else {
                    this.obstacles = [];
                }
                console.log(`障碍物模式已设置为 ${this.config.withObstacles ? "开" : "关"}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                break;
            case 4: // 退出游戏
                Deno.exit(0);
                break;
        }
    }

    // 重置游戏
    private resetGame(): void {
        this.snake = new Snake(Math.floor(this.config.width / 2), Math.floor(this.config.height / 2));
        this.generateFood();
        this.generateObstacles();
        this.score = 0;
        this.foodEaten = 0;
        this.updateBoard();
    }

    // 运行游戏
    async run(): Promise<void> {
        // 初始绘制
        this.draw();

        // 启动输入处理
        this.handleInput();

        // 游戏主循环
        while (true) {
            if (this.state === GameState.Playing) {
                this.update();
                this.draw();
            }

            // 控制游戏循环速度
            await new Promise(resolve => setTimeout(resolve, 40)); // 约25fps
        }
    }
}

// 主函数
async function main() {
    console.clear();
    console.log("正在启动贪吃蛇游戏...");

    try {
        const game = new SnakeGame();
        await game.run();
    } catch (error) {
        console.error("游戏发生错误:", error);
        Deno.exit(1);
    }
}

// 启动游戏
if (import.meta.main) {
    Deno.addSignalListener("SIGINT", () => Deno.exit(0))
    await main();
}
